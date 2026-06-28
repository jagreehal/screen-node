// Root project's own postinstall — just reports WHERE it executed, so you can see
// it ran in the container (a throwaway hostname / linux platform), not on the host.
const os = require('os');
console.log(
  `[postinstall] root script ran in: host=${os.hostname()} ` +
  `platform=${os.platform()} arch=${os.arch()} uid=${process.getuid ? process.getuid() : 'n/a'}`
);
