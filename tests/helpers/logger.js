const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

/**
 * Logger double that records every call, so tests can assert on events without console noise.
 * Child loggers write into the parent's `records`, with their bindings merged in.
 *
 * @returns {{ records: { level: string, fields: object }[] } & Record<string, Function>}
 */
export function createRecordingLogger() {
  const records = [];
  const logger = { records };
  for (const level of LEVELS) {
    logger[level] = (fields) => records.push({ level, fields: fields ?? {} });
  }
  logger.child = (bindings) => {
    const child = createRecordingLogger();
    for (const level of LEVELS) {
      child[level] = (fields) =>
        records.push({ level, fields: { ...bindings, ...(fields ?? {}) } });
    }
    return child;
  };
  return logger;
}

/** Logger double that discards everything (for tests that do not look at logs). */
export function createSilentLogger() {
  const noop = () => {};
  const logger = { level: 'silent', silent: noop };
  for (const level of LEVELS) logger[level] = noop;
  logger.child = () => logger;
  return logger;
}
