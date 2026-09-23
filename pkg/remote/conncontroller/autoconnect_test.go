// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package conncontroller

import (
	"context"
	"errors"
	"fmt"
	"syscall"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/remote"
	"github.com/wavetermdev/waveterm/pkg/utilds"
)

func TestIsRetryableConnError(t *testing.T) {
	dialErr := utilds.MakeSubCodedError(remote.ConnErrCode_Dial, remote.DialSubCode_Refused, syscall.ECONNREFUSED)
	jumpErr := utilds.MakeSubCodedError(remote.ConnErrCode_ProxyJumpDial, remote.DialSubCode_Timeout, errors.New("timeout"))
	canceledDial := utilds.MakeSubCodedError(remote.ConnErrCode_Dial, remote.DialSubCode_ContextCanceled, context.Canceled)
	authErr := utilds.MakeSubCodedError(remote.ConnErrCode_AuthFailed, remote.AuthSubCode_UnableToAuth, errors.New("no auth"))
	cancelErr := utilds.MakeSubCodedError(remote.ConnErrCode_UserCancelled, "", errors.New("cancelled"))

	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"dial refused", dialErr, true},
		{"wrapped dial refused", fmt.Errorf("connecting: %w", dialErr), true},
		{"proxy jump timeout", jumpErr, true},
		{"dial context canceled", canceledDial, false},
		{"auth failed", authErr, false},
		{"user cancelled", cancelErr, false},
		{"plain context canceled", context.Canceled, false},
	}
	for _, c := range cases {
		if got := isRetryableConnError(c.err); got != c.want {
			code, sub := remote.ClassifyConnError(c.err)
			t.Errorf("%s: got %v want %v (classified %q/%q)", c.name, got, c.want, code, sub)
		}
	}
}
