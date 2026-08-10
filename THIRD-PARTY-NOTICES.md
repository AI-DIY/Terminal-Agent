# Third-party notices

## ppk-to-openssh 3.2.0

- Purpose: convert user-supplied PuTTY `.ppk` private keys to the OpenSSH
  representation accepted by the SSH transport.
- License: GPL-3.0.
- Source: <https://github.com/cartpauj/ppk-to-openssh>

The dependency is isolated behind the `PpkConverter` adapter so application
code does not depend on its package API.
