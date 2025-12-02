// models/DeploymentTimestamp.js
import mongoose from 'mongoose';

const deploymentVersionSchema = new mongoose.Schema({
  version: {
    type: Number,
    default: 1
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

deploymentVersionSchema.statics.getCurrentVersion = async function() {
  const currentVersion = await this.findOne().sort('-version');
  return currentVersion ? currentVersion.version : 1;
};

deploymentVersionSchema.statics.incrementVersion = async function() {
  const currentVersion = await this.getCurrentVersion();
  await this.create({ version: currentVersion + 1 });
  return currentVersion + 1;
};

const DeploymentVersion = mongoose.model('DeploymentVersion', deploymentVersionSchema);

export default DeploymentVersion;