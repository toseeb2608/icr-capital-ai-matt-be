import User from "../models/user.js"
import Company from "../models/companyModel.js";
import Team from "../models/teamModel.js";
import { StatusCodes } from 'http-status-codes';
import Config from "../models/configurationModel.js";
import sendEmail from "../utils/mailGun.js";
import { AuthMessages } from "../constants/enums.js";
import { BadRequest, Unauthorized } from "../middlewares/customError.js";
import ResetToken from "../models/token.js";
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import BcryptSalt from 'bcrypt-salt';
import config from '../config.js';
import axios from "axios";
import DeploymentTimestamp from "../models/DeploymentTimestamp.js";
import jwt from 'jsonwebtoken'
import Notification from "../models/notifications.js";
// import fetch from 'node-fetch';
import logger from '../log.js'

/**
 * Registers a new user.
 *
 * @param req - The Express request object
 * @param res - The Express response object
 * @param next - The Express next middleware function
 * @returns AuthMessages.USER_REGISTERED_SUCCESSFULLY if user successfully registered
 */


export const registerUser = async (req, res, next) => {
  let djangoUserEmail = null;
  let mongoUser = null;

  try {
    const { fname, lname, password, email, username, role, companyId, teams, status='active', type } = req.body;

    let checkCompanyId = companyId != null ? companyId : '65d73e9ce5cf164f95c77fb3';

    const generatedPassword = "microsoftSSO@123"



    let updateUserPassword;

    if(type === 'microsoftSSO') {
      updateUserPassword = generatedPassword; 
    }
    else
    {
      updateUserPassword = password;
    }


    // Check if email already exists
    const emailExist = await User.findOne({ email });
    if (emailExist) {
      return next(BadRequest(AuthMessages.EMAIL_ALREADY_EXISTS));
    }

    // Check if username already exists
    const usernameExists = await User.findOne({ username });
    if (usernameExists) {
      return next(BadRequest(AuthMessages.USERNAME_ALREADY_EXISTS));
    }

    // Fetch max user tokens from configuration
    const tokens = await Config.findOne({ key: 'tokens' });
    let maxUserTokens = tokens?.maxusertokens ? parseInt(tokens.maxusertokens) : 5000;

    if (['ceda', 'admin', 'superadmin', 'user'].includes(role)) {
      const djangoResponse = await axios.post(`${process.env.REGISTER_DJANGO_API_URL}signup`, {
        fname,
        email,
        password:updateUserPassword
      }, {
        headers: { 'Content-Type': 'application/json' }
      });

      if (!djangoResponse.data.success) {
        throw new Error("Django registration failed: " + JSON.stringify(djangoResponse.data));
      }

      djangoUserEmail = email;
      console.log("Django user created with email:", djangoUserEmail);
    }

  
    mongoUser = await User.create({
      fname,
      lname,
      password: updateUserPassword,
      email,
      role,
      username,
      companyId: checkCompanyId,
      maxusertokens: maxUserTokens,
      status,
      ...(teams ? { teams } : {})
    });
    

    await sendEmail(mongoUser.email, "User Signup", { name: mongoUser.fname, email: mongoUser.email, updateUserPassword }, "../utils/template/adminApprovedUser.handlebars", false);

    res.status(StatusCodes.CREATED).json({ msg: AuthMessages.USER_REGISTERED_SUCCESSFULLY });

  } catch (error) {
    console.error("Error in registerUser:", error);

    if (djangoUserEmail) {
      
      try {
        const deleteResponse = await axios.post(`${process.env.REGISTER_DJANGO_API_URL}delete-user`, 
          { email: djangoUserEmail },
          { headers: { 'Content-Type': 'application/json' } }
        );
        if (deleteResponse.data.success) {
          console.log("Django user deleted successfully");
        } else {
          console.error("Failed to delete Django user:", deleteResponse.data);
        }
      } catch (deleteError) {
        console.error("Error deleting Django user:", deleteError.response?.data || deleteError.message);
      }
    } 
    

    if (mongoUser) {
      try {
        await User.findByIdAndDelete(mongoUser._id);
        console.log("MongoDB user deleted successfully");
      } catch (deleteError) {
        console.error("Error deleting MongoDB user:", deleteError);
      }
    }

    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: AuthMessages.FAILED_TO_REGISTER_USER,
    });
  }
};



/**
 * Asynchronous function for logging in a user.
 * 
 * @async
 * @param {Object} req - The request object, containing `body` which holds login information.
 * @param {Object} res - The response object.
 * @param {function} next - The next middleware function.
 * @returns {Promise<response>} The response object providing token and user details in case of success or an error.
 * @throws Will return error if input parameters are missing or if login attempt is unsuccessful.
 */


export const loginUser = async (req, res, next) => {
  try {
    const { email: tempEmail, password, azureToken } = req.body;
    logger.info(`Login attempt for email: ${tempEmail}, using AzureAD: ${!!azureToken}`);
    let companyId = '65d73e9ce5cf164f95c77fb3';

    if (azureToken) {
      // Azure AD authentication
      try {
        logger.info(`Decoding Azure AD token for email: ${tempEmail}`);

        // Decode the token without verification
        const decodedToken = jwt.decode(azureToken);

        logger.info(`Fetching user info from Microsoft Graph for email: ${tempEmail}`);
        const graphResponse = await fetch('https://graph.microsoft.com/v1.0/me', {
          headers: { 'Authorization': `Bearer ${azureToken}` }
        });

        if (!graphResponse.ok) {
          const errorText = await graphResponse.text();
          logger.error(`Graph API error: ${errorText}`);
          throw new Error('Failed to fetch user info from Microsoft Graph');
        }

        const azureUser = await graphResponse.json();
        logger.info(`Retrieved Azure AD user info: ${JSON.stringify(azureUser)}`);

        let user = await User.findOne({ email: azureUser.userPrincipalName.toLowerCase() });

        if (!user) {
          logger.info(`User not found in MongoDB, creating new user for: ${azureUser.userPrincipalName}`);

          const role = 'user';
          const generatedPassword = Math.random().toString(36).slice(-8);

          let djangoUserCreated = false;
          let mongoUserCreated = false;

          try {
            logger.info(`Creating user in Django system for: ${azureUser.userPrincipalName}`);
            const djangoResponse = await axios.post(`${process.env.REGISTER_DJANGO_API_URL}signup`, {
              fname: azureUser.givenName,
              email: azureUser.userPrincipalName.toLowerCase(),
              password: generatedPassword
            }, {
              headers: { 'Content-Type': 'application/json' }
            });

            if (djangoResponse.data.success === true) {
              djangoUserCreated = true;
              logger.info(`Successfully created user in Django for: ${azureUser.userPrincipalName}`);

              user = new User({
                email: azureUser.userPrincipalName.toLowerCase(),
                fname: azureUser.givenName,
                lname: azureUser.surname,
                companyId: companyId,
                username: azureUser.userPrincipalName.split('@')[0].toLowerCase(),
                password: generatedPassword,
                azureADId: azureUser.id,
                authMethod: 'azureAD',
                status: 'pending',
                role: role,
              });

              await user.save();
              mongoUserCreated = true;
              logger.info(`Successfully created MongoDB user for: ${azureUser.userPrincipalName}`);

              await Notification.create({
                type: 'SSO_LOGIN',
                details: {
                  userId: user._id,
                  userName: `${user.fname} ${user.lname}`,
                  userEmail: user.email,
                  status: user.status,
                  timestamp: new Date()
                },
                isRead: false
              }).catch(err => {
                console.error('Failed to create notification:', err);
                logger.error(`Failed to create notification for ${azureUser.userPrincipalName}: ${err}`);
              });

            } else {
              logger.error(`Django user creation failed for ${azureUser.userPrincipalName}`);
              throw new Error('Django user creation failed');
            }
          } catch (error) {
            logger.error(`User creation failed for ${azureUser.userPrincipalName}: ${error.message}`);

            if (djangoUserCreated) {
              try {
                await axios.post(`${process.env.REGISTER_DJANGO_API_URL}delete-user`, 
                  { email: azureUser.userPrincipalName.toLowerCase() },
                  { headers: { 'Content-Type': 'application/json' } }
                );
                logger.info(`Deleted partially created Django user: ${azureUser.userPrincipalName}`);
              } catch (deleteError) {
                console.error("Error deleting Django user:", deleteError);
                logger.error(`Error deleting Django user: ${deleteError.message}`);
              }
            }

            if (mongoUserCreated) {
              try {
                await User.findOneAndDelete({ email: azureUser.userPrincipalName.toLowerCase() });
                logger.info(`Deleted partially created MongoDB user: ${azureUser.userPrincipalName}`);
              } catch (deleteError) {
                console.error("Error deleting MongoDB user:", deleteError);
                logger.error(`Error deleting MongoDB user: ${deleteError.message}`);
              }
            }

            return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: AuthMessages.FAILED_TO_REGISTER_USER });
          }
        }

        if (user.status === "inactive") {
          logger.warn(`Login attempt failed for inactive user: ${user.email}`);
          return next(Unauthorized(AuthMessages.REJECTED_USER));
        }
        if(user.status === "pending"){
          logger.warn(`Login attempt failed for pending user: ${user.email}`);
          return next(Unauthorized(AuthMessages.INACTIVE_USER));
        }

        const comp = await Company.findOne({ _id: user.companyId });
        if (comp && comp.status === "inactive") {
          logger.warn(`Login attempt failed due to inactive company: ${user.companyId}`);
          return next(Unauthorized(AuthMessages.INACTIVE_COMPANY));
        }
                // Check team access
        const teams = user?.teams?.length ? await Team.find({ _id: { $in: user?.teams } }) : [];
        let hasAccess = teams.some(team => team.hasAssistantCreationAccess);

        // Create JWT token
        const token = await user.createJWT();
        logger.info(`Login successful for Azure AD user: ${user.email}`);

        return res.status(StatusCodes.OK).json({
          token,
          userName: user.fname,
          userid: user._id,
          compId: user.companyId,
          role: user.role,
          user_email: user.email,
          teams: user.teams,
          hasAccess: hasAccess,
          isAzureAD: true
        });

      } catch (error) {
        console.error("Azure AD authentication error:", error);
        logger.error(`Azure AD authentication error: ${error.message}`);
        return next(Unauthorized(AuthMessages.INVALID_AZURE_TOKEN));
      }
    } else {
      const email = tempEmail.toLowerCase();

      if (!email || !password) {
        logger.warn(`Login attempt failed due to missing email or password`);
        return next(BadRequest(AuthMessages.EMPTY_EMAIL_OR_PASSWORD));
      }

      const user = await User.findOne({ email });

      if (!user || user?.deletedEmail === email) {
        logger.warn(`Login attempt failed: User not found for email: ${email}`);
        return next(Unauthorized(AuthMessages.USER_NOT_FOUND));
      }

      const correctPassword = await user.comparePasword(password);
      if (!correctPassword) {
        logger.warn(`Login attempt failed: Incorrect password for email: ${email}`);
        return next(Unauthorized(AuthMessages.INVALID_PASSWORD));
      }

      if (user.status === "inactive") {
        return next(Unauthorized(AuthMessages.INACTIVE_USER));
      }

      const comp = await Company.findOne({ _id: user.companyId });
      if (comp && comp.status === "inactive") {
        return next(Unauthorized(AuthMessages.INACTIVE_COMPANY));
      }

      const teams = user?.teams?.length ? await Team.find({ _id: { $in: user?.teams } }) : [];
      let hasAccess = teams.some(team => team.hasAssistantCreationAccess);

      const token = await user.createJWT();
      logger.info(`Login successful for non-Azure user: ${email}`);

      return res.status(StatusCodes.OK).json({
        token,
        userName: user.fname,
        userid: user._id,
        compId: user.companyId,
        role: user.role,
        user_email: user.email,
        teams: user.teams,
        hasAccess: hasAccess,
        isAzureAD: false
      });
    }
  } catch (error) {
    console.error("Login error:", error);
    logger.error(`Login error: ${error.message}`);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: AuthMessages.FAILED_TO_LOGIN });
  }
};



export const logoutUser = async (req, res) => {
  try {
    const { isAzureAD } = req.body;

    if (isAzureAD) {
      const tenantId = process.env.AZURE_AD_TENANT_ID;

      if (!tenantId) {
        throw new Error("Azure AD Tenant ID is missing in environment variables");
      }


      const azureLogoutUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/logout`;
    
      res.status(200).json({ 
        message: 'Logout successful from SSO',
        logoutUrl: azureLogoutUrl
      });
    } else {
      res.status(200).json({ message: 'Logout successful' });
    }
  } catch (error) {
    console.error("Server error during logout:", error);
    res.status(500).json({ message: 'Internal server error during logout', error: error.message });
  }
};



/**
 * Asynchronous function for updating a user's password.
 * 
 * @async
 * @param {Object} req - The request object, containing `body` which holds the user's email.
 * @param {Object} res - The response object.
 * @param {function} next - The next middleware function.
 * @returns {Promise<response>} The response object providing password reset link in case of success or an error message in case of failure.
 * @throws Will return error if email does not exist in system or if process fails.
 */
export const UpdateUserPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return next(Unauthorized(AuthMessages.EMAIL_DOES_NOT_EXIST));
    }

    // Delete existing reset tokens for the user
    await ResetToken.deleteOne({ userId: user._id });

    const resetToken = crypto.randomBytes(32).toString("hex");
    const hash = bcrypt.hashSync(resetToken, 10);

    // Store new reset token in the database
    await new ResetToken({
      userId: user._id,
      token: hash,
      createdAt: Date.now(),
    }).save();

    const clientUrl = config.CLIENT_URL;
    const link = `${clientUrl}/passwordReset/${resetToken}/${user._id}`;

    // Send password reset email
    sendEmail(user.email, "Password Reset Request", { name: user.fname, link }, "../utils/template/requestResetPassword.handlebars", false);

    res.status(StatusCodes.OK).json({ msg: link });
  } catch (error) {
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: AuthMessages.FAILED_TO_UPDATE_PASSWORD });
  }
};

/**
 * Asynchronous function for resetting a user's password.
 * 
 * @async
 * @param {Object} req - The request object, containing `body` which holds the user's userId, password reset token and new password.
 * @param {Object} res - The response object.
 * @param {function} next - The next middleware function.
 * @returns {Promise<response>} The response object providing success message in case of successful password reset or an error message in case of failure.
 * @throws Will return error if password reset token is invalid or expired, or if process fails.
 */
export const resetPassword = async (req, res, next) => {
  try {
    const { userId, token, password } = req.body;

    const passwordResetToken = await ResetToken.findOne({ userId });

    if (!passwordResetToken) {
      return next(Unauthorized(AuthMessages.TOKEN_NOT_FOUND));
    }

    const storedTokenHash = passwordResetToken.token;
    const isValidToken = await bcrypt.compare(token, storedTokenHash);
    if (!isValidToken) {
      return next(Unauthorized(AuthMessages.INVALID_TOKEN));
    }

    const hashedPassword = await bcrypt.hash(password, Number(BcryptSalt));
    const user = await User.findById(userId);
    if (user.password === hashedPassword) {
      return next(BadRequest(AuthMessages.SAME_PASSWORD));
    }
    await User.findByIdAndUpdate(userId, { password: hashedPassword });

    // Send password reset success email (uncomment if needed)
    // const user = await User.findById(userId);
    // sendEmail(user.email, "Password Reset Successfully", { name: user.fname }, "../utils/template/requestResetPassword.handlebars");

    await passwordResetToken.deleteOne();

    res.status(StatusCodes.OK).json({ msg: AuthMessages.PASSWORD_UPDATED_SUCCESSFULLY });
  } catch (error) {
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: AuthMessages.FAILED_TO_RESET_PASSWORD });
  }
};