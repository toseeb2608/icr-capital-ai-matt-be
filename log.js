import winston from 'winston';

const logger = winston.createLogger({
  level: 'info', // Log 'info' level and above (info, warn, error)
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })
  ),
  
  transports: [
    new winston.transports.Console(),              
    new winston.transports.File({ filename: 'login_logs.log' })  
  ]
});

export default logger;