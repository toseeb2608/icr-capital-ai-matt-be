
import jwt from "jsonwebtoken";
 import * as locale from "../locale/index.js";
import User from "../models/user.js";
import config from '../config.js';  
import DeploymentVersion from "../models/DeploymentTimestamp.js";
import passport from "passport"
import { BearerStrategy } from 'passport-azure-ad';
import { StatusCodes } from 'http-status-codes';

const options = {
  identityMetadata: `https://login.microsoftonline.com/${process.env.AZURE_AD_TENANT_ID}/v2.0/.well-known/openid-configuration`,
  clientID: process.env.AZURE_AD_CLIENT_ID,
  audience: process.env.AZURE_AD_CLIENT_ID,
  validateIssuer: false,  // Set to false for multi-tenant applications
  passReqToCallback: false,
  // loggingLevel: 'info',
  loggingNoPII: false
};

passport.use(new BearerStrategy(options, (token, done) => {
  return done(null, token);
}));


export const userActions = {
  login: { maxAttempts: 500, mins: 60, message: locale.LOGIN_MANY_ATTEMPT },
  register: { maxAttempts: 500, mins: 60, message: locale.SIGNUP_MANY_ATTEMPT },
  forgotPassword: {
    maxAttempts: 500,
    mins: 60,
    message: locale.FORGOTPASS_MANY_ATTEMPT,
  },
};


export const actionLimitter = (action) =>
  rateLimit({
    windowMs: 1000 * 60 * action.mins,
    max: action.maxAttempts,
    message: action.message,
    standardHeaders: true,
    legacyHeaders: false, 
    handler: (req, res, next, options) =>
      res.status(options.statusCode).send({ errorMessage: options.message }),
  });




function validateToken(token) {
  return typeof token === 'string' && token.trim() !== '';
}

export const authorizeUserAction = (resourceUser, reqUser) => {
  if(reqUser.role === 'superadmin') return true;
  if(resourceUser.toString() === reqUser._id.toString()) return true;
  return false;
}

// Middleware function to validate header tokens
const authenticateUser = async (req, res, next) => {
  try {
    if (!req.headers['authorization']) {
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No authorization headers sent' });
    }

    const authHeader = req.headers['authorization'];
    const [authType, token] = authHeader.split(' ');

    if (authType.toLowerCase() === 'bearer') {
      passport.authenticate('oauth-bearer', { session: false }, async (err, azureUser, info) => {
        if (azureUser) {
          const dbUser = await User.findOne({ email: azureUser.preferred_username || azureUser.email });
          if (!dbUser) {
            return res.status(StatusCodes.NOT_FOUND).json({ error: 'User not found' });
          }
          req.user = dbUser;
          return next();
        } else {
        
          try {
            const decodedToken = jwt.verify(token, config.JWT_SECRET, { ignoreExpiration: true });
            const curTime = new Date().getTime() / 1000;

            if (decodedToken.exp < curTime) {
              res.setHeader('x-token-expiry', 'true');
              return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Token expired' });
            }

            const currentVersion = await DeploymentVersion.getCurrentVersion();
            if (decodedToken.deployVersion < currentVersion) {
              return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'New deployment detected. Please log in again.' });
            }

            const user = await User.findOne({ _id: decodedToken.userId });
            if (user && user?._id) {
              req.user = user;
              return next();
            } else {
              return res.status(StatusCodes.NOT_FOUND).json({ error: 'User not found' });
            }
          } catch (jwtError) {
            return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Invalid token' });
          }
        }
      })(req, res, next);
    } else {
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Invalid authorization type' });
    }
  } catch (e) {
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Error occurred while validating authentication token', message: e.message });
  }
};

export async function authenticateSocket(socket, next) {
  try {
    // Get the token from the query parameter or socket handshake headers
    const token = socket.handshake.auth.token || socket.handshake.query.token;
    if (!token) {
      return next(new Error('Authentication error: Token not provided'));
    }

    // Your existing token validation logic
    if (!validateToken(token)) {
      return next(new Error('Authentication error: Invalid token'));
    }

    const decodedToken = jwt.verify(token, config.JWT_SECRET, { ignoreExpiration: true });
    const curTime = new Date().getTime() / 1000;
    if (decodedToken.exp < curTime) {
      // Token has expired
      return next(new Error('Authentication error: Token expired'));
    }

    // Fetch user by ID from the decoded token and attach the user to the socket for future use
    const user = await User.findOne({ _id: decodedToken.userId });
    if (user && user._id) {
      socket.user = decodedToken;
      next();
    } else {
      return next(new Error('Authentication error: User not found'));
    }
  } catch (e) {
    console.log("🚀 ~ authenticateSocket ~ e:", e)
    return next(new Error('Authentication error: ' + e.message));
  }
}

export default authenticateUser;


