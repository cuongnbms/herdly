/** `.env`, `.env.<stage>` and `<stage>.env`: KEY=value lines with `#` comments, read as INI / properties. */
export function isEnvFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return /^\.env(\..+)?$/.test(name) || /.\.env$/.test(name);
}
