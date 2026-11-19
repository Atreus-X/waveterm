package fileutil

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestIsWindowsFileBusyErr(t *testing.T) {
	busy := &os.LinkError{Op: "rename", Old: "a.tmp", New: "a", Err: syscall.Errno(32)}
	if !isWindowsFileBusyErr(busy) {
		t.Errorf("sharing violation should be busy")
	}
	if !isWindowsFileBusyErr(fmt.Errorf("wrapped: %w", &os.LinkError{Err: syscall.Errno(5)})) {
		t.Errorf("wrapped access denied should be busy")
	}
	if !isWindowsFileBusyErr(&os.LinkError{Err: syscall.Errno(33)}) {
		t.Errorf("lock violation should be busy")
	}
	if isWindowsFileBusyErr(&os.LinkError{Err: syscall.Errno(2)}) || isWindowsFileBusyErr(errors.New("nope")) {
		t.Errorf("other errors should not be busy")
	}
	if isWindowsFileBusyErr(nil) {
		t.Errorf("nil should not be busy")
	}
}

func TestRetryRename(t *testing.T) {
	errBusy := errors.New("busy")
	isBusy := func(err error) bool { return errors.Is(err, errBusy) }

	t.Run("succeeds after a few busy attempts", func(t *testing.T) {
		calls := 0
		var slept []time.Duration
		err := retryRename(func() error {
			calls++
			if calls < 4 {
				return errBusy
			}
			return nil
		}, isBusy, func(d time.Duration) { slept = append(slept, d) })
		if err != nil || calls != 4 {
			t.Fatalf("err=%v calls=%d", err, calls)
		}
		want := []time.Duration{10 * time.Millisecond, 20 * time.Millisecond, 40 * time.Millisecond}
		if fmt.Sprint(slept) != fmt.Sprint(want) {
			t.Errorf("slept %v, want %v", slept, want)
		}
	})

	t.Run("a different error stops at once", func(t *testing.T) {
		other := errors.New("not busy")
		calls := 0
		err := retryRename(func() error { calls++; return other }, isBusy, func(time.Duration) { t.Errorf("slept") })
		if err != other || calls != 1 {
			t.Fatalf("err=%v calls=%d", err, calls)
		}
	})

	t.Run("gives up with the last error, backing off to the cap, without a final sleep", func(t *testing.T) {
		calls := 0
		var total time.Duration
		var longest time.Duration
		err := retryRename(func() error { calls++; return errBusy }, isBusy, func(d time.Duration) {
			total += d
			longest = max(longest, d)
		})
		if !errors.Is(err, errBusy) || calls != renameRetryAttempts {
			t.Fatalf("err=%v calls=%d", err, calls)
		}
		if longest != renameRetryMaxDelay {
			t.Errorf("longest sleep %v, want the %v cap", longest, renameRetryMaxDelay)
		}
		if total < time.Second || total > 3*time.Second {
			t.Errorf("total wait %v, want roughly 2s", total)
		}
	})
}

func TestAtomicWriteFile(t *testing.T) {
	tmpDir := t.TempDir()
	fileName := filepath.Join(tmpDir, "settings.json")

	err := AtomicWriteFile(fileName, []byte(`{"key":"value"}`), 0644)
	if err != nil {
		t.Fatalf("AtomicWriteFile failed: %v", err)
	}

	data, err := os.ReadFile(fileName)
	if err != nil {
		t.Fatalf("ReadFile failed: %v", err)
	}
	if string(data) != `{"key":"value"}` {
		t.Fatalf("unexpected file contents: %q", string(data))
	}
	if _, err := os.Stat(fileName + TempFileSuffix); !os.IsNotExist(err) {
		t.Fatalf("temporary file should not exist, stat err: %v", err)
	}
}

func TestAtomicWriteFileRenameErrorCleansTempFile(t *testing.T) {
	tmpDir := t.TempDir()
	fileName := filepath.Join(tmpDir, "settings.json")

	if err := os.Mkdir(fileName, 0755); err != nil {
		t.Fatalf("Mkdir failed: %v", err)
	}

	err := AtomicWriteFile(fileName, []byte(`{"key":"value"}`), 0644)
	if err == nil {
		t.Fatalf("AtomicWriteFile expected error")
	}
	if _, statErr := os.Stat(fileName + TempFileSuffix); !os.IsNotExist(statErr) {
		t.Fatalf("temporary file should be removed on rename error, stat err: %v", statErr)
	}
}
