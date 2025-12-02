// First create models/notification.js
import { stat } from 'fs';
import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['SSO_LOGIN', 'SYSTEM', 'USER_ACTION'],
    required: true
  },
  details: {
    userId: String,
    userName: String,
    userEmail: String,
    status: String,
    timestamp: Date
  },
  isRead: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

const Notification = mongoose.model('Notification', notificationSchema);
export default Notification;