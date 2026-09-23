// Copyright 2026, Atreus-X (fork of Wave Terminal by Command Line Inc.)
// SPDX-License-Identifier: Apache-2.0

package conncontroller

import (
	"context"
	"errors"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/remote"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// IsAutoConnectEnabled reports whether conn:autoconnect is on for connName
// (connection config -> global settings -> default true).
func IsAutoConnectEnabled(connName string) bool {
	fullConfig := wconfig.GetWatcher().GetFullConfig()
	if connConfig, ok := fullConfig.Connections[connName]; ok && connConfig.ConnAutoConnect != nil {
		return *connConfig.ConnAutoConnect
	}
	return wconfig.DefaultBoolPtr(fullConfig.Settings.ConnAutoConnect, true)
}

// isRetryableConnError is true for network-level failures (host down, no route, timeout...),
// which are worth retrying unattended. Auth, host key and user-prompt failures are not:
// retrying those would just re-prompt the user or hammer a host that will keep refusing.
func isRetryableConnError(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) {
		return false
	}
	code, subCode := remote.ClassifyConnError(err)
	if code != remote.ConnErrCode_Dial && code != remote.ConnErrCode_ProxyJumpDial {
		return false
	}
	return subCode != remote.DialSubCode_ContextCanceled
}

// ConnectUnattended connects connName if needed. Unlike EnsureConnection it also retries a
// connection that is in the error state. Returns whether a failure is worth retrying.
func ConnectUnattended(ctx context.Context, connName string) (retryable bool, err error) {
	opts, err := remote.ParseOpts(connName)
	if err != nil {
		return false, fmt.Errorf("error parsing connection name: %w", err)
	}
	conn := GetConn(opts)
	if conn == nil {
		return false, fmt.Errorf("connection not found: %s", connName)
	}
	switch conn.DeriveConnStatus().Status {
	case Status_Connected:
		return false, nil
	case Status_Connecting:
		err = conn.WaitForConnect(ctx)
	default:
		err = conn.Connect(ctx, &wconfig.ConnKeywords{})
	}
	if err != nil {
		return isRetryableConnError(err), err
	}
	return false, nil
}
