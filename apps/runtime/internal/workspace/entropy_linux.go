//go:build linux

package workspace

import (
	"log/slog"
	"os"
	"unsafe"

	"golang.org/x/sys/unix"
)

const entropySeedBytes = 256

type randPoolInfo struct {
	entropyCount int32
	bufSize      int32
	buf          [entropySeedBytes]byte
}

func EnsureEntropy() {
	seed := make([]byte, entropySeedBytes)
	urandom, err := os.Open("/dev/urandom")
	if err != nil {
		slog.Warn("failed to open /dev/urandom for entropy seed", "error", err)
		return
	}
	n, err := urandom.Read(seed)
	_ = urandom.Close()
	if err != nil || n != entropySeedBytes {
		slog.Warn("failed to read entropy seed from /dev/urandom", "error", err, "n", n)
		return
	}

	random, err := os.OpenFile("/dev/random", os.O_RDWR, 0)
	if err != nil {
		slog.Warn("failed to open /dev/random for entropy credit", "error", err)
		return
	}
	defer random.Close()

	info := randPoolInfo{
		entropyCount: int32(n * 8),
		bufSize:      int32(n),
	}
	copy(info.buf[:], seed)

	_, _, errno := unix.Syscall(
		unix.SYS_IOCTL,
		random.Fd(),
		uintptr(unix.RNDADDENTROPY),
		uintptr(unsafe.Pointer(&info)),
	)
	if errno != 0 {
		slog.Warn("failed to credit guest entropy via RNDADDENTROPY", "error", errno)
		return
	}

	slog.Info("credited guest kernel entropy for TLS/getrandom", "bits", n*8)
}
