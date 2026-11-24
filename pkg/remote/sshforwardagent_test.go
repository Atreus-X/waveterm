// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package remote

import (
	"crypto/ed25519"
	"crypto/rand"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kevinburke/ssh_config"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"golang.org/x/crypto/ssh"
)

// fakeAgent listens on a unix socket and answers every connection with a fixed reply after reading a request,
// standing in for the user's local ssh agent. It counts connections so the test can see per-channel dialing.
type fakeAgent struct {
	path  string
	ln    net.Listener
	conns chan struct{}
}

func startFakeAgent(t *testing.T, reply string) *fakeAgent {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agent.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	fa := &fakeAgent{path: path, ln: ln, conns: make(chan struct{}, 16)}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			fa.conns <- struct{}{}
			go func() {
				defer c.Close()
				buf := make([]byte, 4)
				if _, err := io.ReadFull(c, buf); err != nil {
					return
				}
				c.Write([]byte(reply + string(buf)))
			}()
		}
	}()
	t.Cleanup(func() { ln.Close() })
	return fa
}

// testSshServer is a minimal in-process ssh server: no auth, one session at a time. When a session asks for
// agent forwarding (auth-agent-req@openssh.com) it opens an agent channel back to the client, sends "ping",
// and reports the bytes it got back on agentReplies.
type testSshServer struct {
	addr         string
	agentReplies chan string
	sawAgentReq  chan bool
	refuseAgent  bool
}

func startTestSshServer(t *testing.T, refuseAgent bool) *testSshServer {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &ssh.ServerConfig{NoClientAuth: true}
	cfg.AddHostKey(signer)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	srv := &testSshServer{
		addr:         ln.Addr().String(),
		agentReplies: make(chan string, 4),
		sawAgentReq:  make(chan bool, 4),
		refuseAgent:  refuseAgent,
	}
	go func() {
		for {
			nc, err := ln.Accept()
			if err != nil {
				return
			}
			go srv.serve(nc, cfg)
		}
	}()
	return srv
}

func (s *testSshServer) serve(nc net.Conn, cfg *ssh.ServerConfig) {
	conn, chans, reqs, err := ssh.NewServerConn(nc, cfg)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(reqs)
	for newCh := range chans {
		if newCh.ChannelType() != "session" {
			newCh.Reject(ssh.UnknownChannelType, "unsupported")
			continue
		}
		ch, chReqs, err := newCh.Accept()
		if err != nil {
			continue
		}
		go func() {
			for req := range chReqs {
				switch req.Type {
				case "auth-agent-req@openssh.com":
					s.sawAgentReq <- true
					if s.refuseAgent {
						req.Reply(false, nil)
						continue
					}
					req.Reply(true, nil)
					go s.exerciseAgent(conn)
				case "shell":
					req.Reply(true, nil)
				default:
					req.Reply(false, nil)
				}
			}
		}()
		_ = ch
	}
}

func (s *testSshServer) exerciseAgent(conn *ssh.ServerConn) {
	ach, areqs, err := conn.OpenChannel("auth-agent@openssh.com", nil)
	if err != nil {
		s.agentReplies <- "open-failed: " + err.Error()
		return
	}
	go ssh.DiscardRequests(areqs)
	ach.Write([]byte("ping"))
	out, _ := io.ReadAll(io.LimitReader(ach, int64(len("fake-ping"))))
	ach.Close()
	s.agentReplies <- string(out)
}

func dialTestServer(t *testing.T, srv *testSshServer) *ssh.Client {
	t.Helper()
	client, err := ssh.Dial("tcp", srv.addr, &ssh.ClientConfig{
		User:            "test",
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         5 * time.Second,
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { client.Close() })
	return client
}

func waitFor[T any](t *testing.T, ch chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
		var zero T
		return zero
	}
}

func TestForwardAgentReachesLocalAgent(t *testing.T) {
	fa := startFakeAgent(t, "fake-")
	srv := startTestSshServer(t, false)
	client := dialTestServer(t, srv)
	kw := &wconfig.ConnKeywords{SshForwardAgent: utilfn.Ptr(true), SshIdentityAgent: utilfn.Ptr(fa.path)}
	if !setupAgentForwarding(client, kw) {
		t.Fatal("setupAgentForwarding returned false with ForwardAgent on")
	}
	session, err := client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if !RequestAgentForwardingIfEnabled(client, session) {
		t.Fatal("agent forwarding was not requested for the session")
	}
	if !waitFor(t, srv.sawAgentReq, "the server to see the forwarding request") {
		t.Fatal("server did not see the request")
	}
	if got := waitFor(t, srv.agentReplies, "the forwarded agent reply"); got != "fake-ping" {
		t.Fatalf("agent reply through the forwarded channel = %q, want %q", got, "fake-ping")
	}
	waitFor(t, fa.conns, "a connection to the local agent")
}

func TestForwardAgentOffDoesNothing(t *testing.T) {
	fa := startFakeAgent(t, "fake-")
	srv := startTestSshServer(t, false)
	client := dialTestServer(t, srv)
	for _, kw := range []*wconfig.ConnKeywords{
		{SshIdentityAgent: utilfn.Ptr(fa.path)},
		{SshForwardAgent: utilfn.Ptr(false), SshIdentityAgent: utilfn.Ptr(fa.path)},
	} {
		if setupAgentForwarding(client, kw) {
			t.Fatalf("forwarding enabled with ForwardAgent unset/false: %+v", kw)
		}
	}
	session, err := client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if RequestAgentForwardingIfEnabled(client, session) {
		t.Fatal("agent forwarding requested although it was never enabled")
	}
	select {
	case <-srv.sawAgentReq:
		t.Fatal("server saw an agent forwarding request")
	case <-time.After(200 * time.Millisecond):
	}
}

func TestForwardAgentWithoutAgentPathStaysOff(t *testing.T) {
	srv := startTestSshServer(t, false)
	client := dialTestServer(t, srv)
	if setupAgentForwarding(client, &wconfig.ConnKeywords{SshForwardAgent: utilfn.Ptr(true)}) {
		t.Fatal("forwarding enabled with no identity agent to forward to")
	}
}

func TestForwardAgentServerRefusalIsNotFatal(t *testing.T) {
	fa := startFakeAgent(t, "fake-")
	srv := startTestSshServer(t, true)
	client := dialTestServer(t, srv)
	if !setupAgentForwarding(client, &wconfig.ConnKeywords{SshForwardAgent: utilfn.Ptr(true), SshIdentityAgent: utilfn.Ptr(fa.path)}) {
		t.Fatal("setup should succeed; the server's answer only matters per session")
	}
	session, err := client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if RequestAgentForwardingIfEnabled(client, session) {
		t.Fatal("reported forwarding although the server refused it")
	}
	if err := session.Shell(); err != nil {
		t.Fatalf("the session must still start after a refusal: %v", err)
	}
}

func TestForwardAgentUnreachableAgentRejectsChannel(t *testing.T) {
	srv := startTestSshServer(t, false)
	client := dialTestServer(t, srv)
	missing := filepath.Join(t.TempDir(), "gone.sock")
	if !setupAgentForwarding(client, &wconfig.ConnKeywords{SshForwardAgent: utilfn.Ptr(true), SshIdentityAgent: utilfn.Ptr(missing)}) {
		t.Fatal("setup should still register the handler")
	}
	session, err := client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if !RequestAgentForwardingIfEnabled(client, session) {
		t.Fatal("request should be sent")
	}
	got := waitFor(t, srv.agentReplies, "the rejected channel result")
	if len(got) < len("open-failed") || got[:len("open-failed")] != "open-failed" {
		t.Fatalf("expected the server's channel open to fail, got %q", got)
	}
}

func TestMergeKeywordsForwardAgent(t *testing.T) {
	base := &wconfig.ConnKeywords{SshForwardAgent: utilfn.Ptr(false)}
	over := &wconfig.ConnKeywords{SshForwardAgent: utilfn.Ptr(true)}
	if !utilfn.SafeDeref(mergeKeywords(base, over).SshForwardAgent) {
		t.Fatal("a later source setting ForwardAgent true must win")
	}
	if utilfn.SafeDeref(mergeKeywords(over, &wconfig.ConnKeywords{}).SshForwardAgent) != true {
		t.Fatal("an unset later source must keep the earlier value")
	}
}

// useTestSshConfig points the ssh config parser at a temp file for the duration of a test.
func useTestSshConfig(t *testing.T, content string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	WaveSshConfigUserSettings() // make sure the once-initialised global exists before swapping it
	old := waveSshConfigUserSettingsInternal
	us := &ssh_config.UserSettings{IgnoreMatchDirective: true}
	us.ConfigFinder(func() string { return path })
	waveSshConfigUserSettingsInternal = us
	t.Cleanup(func() { waveSshConfigUserSettingsInternal = old })
}

func TestForwardAgentKeywordParsing(t *testing.T) {
	useTestSshConfig(t, `Host fwd-on
    HostName 192.0.2.10
    ForwardAgent yes
    IdentityAgent /tmp/agent-test.sock

Host fwd-off
    HostName 192.0.2.11
    ForwardAgent no
    IdentityAgent /tmp/agent-test.sock

Host fwd-unset
    HostName 192.0.2.12
    IdentityAgent /tmp/agent-test.sock

Host fwd-path
    HostName 192.0.2.13
    ForwardAgent /tmp/some-other.sock
    IdentityAgent /tmp/agent-test.sock

Host *
    IdentityAgent /tmp/agent-test.sock
`)
	cases := []struct {
		host string
		want bool
	}{
		{"fwd-on", true},
		{"fwd-off", false},
		{"fwd-unset", false},
		{"fwd-path", false}, // OpenSSH's socket-path form is not supported: stays off
		{"not-in-config", false},
	}
	for _, c := range cases {
		kw, err := findSshConfigKeywords(c.host)
		if err != nil {
			t.Fatalf("%s: %v", c.host, err)
		}
		if got := utilfn.SafeDeref(kw.SshForwardAgent); got != c.want {
			t.Errorf("ForwardAgent for %q = %v, want %v", c.host, got, c.want)
		}
	}
}
