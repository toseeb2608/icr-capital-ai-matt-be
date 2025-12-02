import mongoose from 'mongoose';
import validator from 'validator';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import config from '../config.js';
import DeploymentVersion from "../models/DeploymentTimestamp.js"
export const UserRole = {
	SUPER_ADMIN: 'superadmin',
	CEDA: 'ceda',
	ADMIN: 'admin',
	USER: 'user',
};

const userSchema = new mongoose.Schema(
  {
    maxusertokens: {
      type: Number,
      default: 5000,
    },
    currentusertokens: {
      type: Number,
      default: 0,
    },
    fname: {
      type: String,
      required: [true, 'Please provide name'],
      maxlength: 50,
      minlength: 1,
    },
    lname: {
      type: String,
      // required: [true, 'Please provide name'],
      maxlength: 50,
      minlength: 1,
    },
    username: {
      type: String,
      required: [true, 'Please provide name'],
      maxlength: 50,
      minlength: 1,
      unique: true,
    },
    password: {
      type: String,
      required: [true, 'please provide a password'],
      minlength: 4,
    },
    email: {
      type: String,
      unique: true,
      required: [true, 'Please provide email'],
      validate: {
        validator: validator.isEmail,
        message: 'Please provide valid email',
      },
    },
    status: {
      type: String,
      enum: ['active', 'inactive','pending'],
      default: 'inactive',
    },
    role: {
      type: String,
      enum: ['superadmin', 'ceda', 'user'],
      default: 'user',
    },
    companyId: {
      type: String,
    },
    deletedEmail: {
      type: String,
    },
    teamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Teams',
      required: false  
    },
    teams: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Teams',
        required: false  
      }
    ],
    branch: {
      type: String,
    },
    azureADId: {
      type: String,
      unique: true,
      sparse: true
    },
    authMethod: {
      type: String,
      enum: ['local', 'azureAD'],
      default: 'local'
    }
  },
  { timestamps: true }
);

userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  this.email = this.email.toLowerCase(); // convert email to lowercase
  this.username = this.username.toLowerCase(); // convert username to lowercase
});

userSchema.methods.comparePasword = async function (userPassword) {
  const isMatch = await bcrypt.compare(userPassword, this.password);
  return isMatch;
};

userSchema.methods.createJWT = async function () {
  const currentVersion = await DeploymentVersion.getCurrentVersion();

  return jwt.sign(
    {
      userId: this._id,
      email: this.email,
      role: this.role,
      branch: this.branch,
      deployVersion: currentVersion
    },
    config.JWT_SECRET,
    {
      expiresIn: '24h',
    }
  );
};


const User = mongoose.model('User', userSchema);
export default User;
