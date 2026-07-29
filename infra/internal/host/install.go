package host

import (
	"io"
	"os"

	"github.com/rshdhere/devin/infra/internal/sysutil"
)

func InstallSelf() error {
	if err := sysutil.MustRoot(); err != nil {
		return err
	}
	src, err := os.Executable()
	if err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile("/usr/local/bin/devin-infra", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0755)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}
