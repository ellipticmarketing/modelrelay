import pino from 'pino';
import pretty from 'pino-pretty';

const USE_CONSOLE = process.env.USE_CONSOLE === '1';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_FILE = process.env.LOG_FILE;

function createLogger() {
  if (USE_CONSOLE) {
    return {
      info: (...args) => console.log('[INFO]', ...args),
      warn: (...args) => console.warn('[WARN]', ...args),
      error: (...args) => console.error('[ERROR]', ...args),
      debug: (...args) => console.debug('[DEBUG]', ...args),
      trace: (...args) => console.trace('[TRACE]', ...args),
      child: () => createLogger(),
    };
  }

  if (LOG_FILE) {
    const dest = pino.destination(LOG_FILE, { sync: false });
    return pino({ level: LOG_LEVEL, timestamp: pino.stdTimeFunctions.isoTime }, dest);
  }

  if (process.env.NODE_ENV !== 'production') {
    const transport = pretty({ outputStream: process.stdout, translateTime: true });
    return pino(
      { level: LOG_LEVEL, timestamp: pino.stdTimeFunctions.isoTime },
      transport
    );
  }

  return pino(
    { level: LOG_LEVEL, timestamp: pino.stdTimeFunctions.isoTime, destination: 1 }
  );
}

export const logger = createLogger();
export default logger;
