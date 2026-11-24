// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package remote

import (
	"errors"
	"io"
	"log"
	"strings"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

// agentChannelType is the channel type OpenSSH uses for forwarded agent connections.
const agentChannelType = "auth-agent@openssh.com"

// agentForwardingClients records the ssh clients that were set up for agent forwarding (ForwardAgent yes).
// Only terminal sessions on those clients ask the server to forward the agent; helper sessions never do.
var agentForwardingClients sync.Map // *ssh.Client -> struct{}

// setupAgentForwarding honors ForwardAgent for a freshly connected client. Every channel the remote host opens
// back to us is served by a new connection to the local identity agent (the same agent used for authentication),
// so the agent's own policy applies (including key confirmation, if the agent supports it).
// Returns true when forwarding was enabled. A missing agent only logs: the connection itself is unaffected.
func setupAgentForwarding(client *ssh.Client, sshKeywords *wconfig.ConnKeywords) bool {
	if client == nil || !utilfn.SafeDeref(sshKeywords.SshForwardAgent) {
		return false
	}
	agentPath := strings.TrimSpace(utilfn.SafeDeref(sshKeywords.SshIdentityAgent))
	if agentPath == "" {
		log.Printf("ForwardAgent is on but no identity agent was found (set IdentityAgent or start an ssh agent); not forwarding\n")
		return false
	}
	if err := serveForwardedAgent(client, agentPath); err != nil {
		log.Printf("ForwardAgent: cannot register the agent channel handler: %v\n", err)
		return false
	}
	agentForwardingClients.Store(client, struct{}{})
	go func() {
		client.Wait()
		agentForwardingClients.Delete(client)
	}()
	return true
}

// serveForwardedAgent answers "auth-agent@openssh.com" channels opened by the server by piping each one
// to a new connection to the agent at agentPath (Unix socket or Windows named pipe).
func serveForwardedAgent(client *ssh.Client, agentPath string) error {
	channels := client.HandleChannelOpen(agentChannelType)
	if channels == nil {
		return errors.New("an agent channel handler is already registered on this client")
	}
	go func() {
		for newCh := range channels {
			go handleForwardedAgentChannel(newCh, agentPath)
		}
	}()
	return nil
}

func handleForwardedAgentChannel(newCh ssh.NewChannel, agentPath string) {
	conn, err := dialIdentityAgent(agentPath)
	if err != nil {
		log.Printf("ForwardAgent: cannot reach the local agent %q: %v\n", agentPath, err)
		newCh.Reject(ssh.ConnectionFailed, "could not connect to the local agent")
		return
	}
	ch, reqs, err := newCh.Accept()
	if err != nil {
		conn.Close()
		return
	}
	go ssh.DiscardRequests(reqs)
	var once sync.Once
	closeBoth := func() {
		once.Do(func() {
			ch.Close()
			conn.Close()
		})
	}
	go func() {
		io.Copy(ch, conn)
		closeBoth()
	}()
	go func() {
		io.Copy(conn, ch)
		closeBoth()
	}()
}

// RequestAgentForwardingIfEnabled asks the server to forward the agent for this (interactive) session,
// when the connection was configured with ForwardAgent. Call before the session starts a shell or command.
// A refusal by the server is only logged: the terminal still opens, just without the agent.
func RequestAgentForwardingIfEnabled(client *ssh.Client, session *ssh.Session) bool {
	if client == nil || session == nil {
		return false
	}
	if _, ok := agentForwardingClients.Load(client); !ok {
		return false
	}
	if err := agent.RequestAgentForwarding(session); err != nil {
		log.Printf("ForwardAgent: the server refused agent forwarding for this session: %v\n", err)
		return false
	}
	return true
}
