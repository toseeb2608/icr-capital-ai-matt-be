import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import config from "./config.js";
import connectDb from "./config/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import models
import Assistant from "./models/assistantModel.js";
import User from "./models/user.js";
import Company from "./models/companyModel.js";
import Config from "./models/configurationModel.js";

const importData = async () => {
  try {
    // Connect to database
    await connectDb();
    console.log("Connected to MongoDB");

    // File mappings: filename -> { model, collection }
    const fileMappings = [
      {
        file: "icrai.assistants.json",
        model: Assistant,
        collection: "assistants"
      },
      {
        file: "icrai.users.json",
        model: User,
        collection: "users"
      },
      {
        file: "icrai.companies.json",
        model: Company,
        collection: "companies"
      },
      {
        file: "icrai.configs.json",
        model: Config,
        collection: "configs"
      }
    ];

    for (const mapping of fileMappings) {
      const filePath = path.join(__dirname, mapping.file);
      
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        console.log(`⚠️  File not found: ${mapping.file} - Skipping...`);
        continue;
      }

      console.log(`\n📂 Importing ${mapping.file}...`);
      
      // Read and parse JSON file
      const fileContent = fs.readFileSync(filePath, "utf8");
      let data = JSON.parse(fileContent);

      // Handle both array and single object
      const documents = Array.isArray(data) ? data : [data];

      if (documents.length === 0) {
        console.log(`   ⚠️  No data found in ${mapping.file}`);
        continue;
      }

      // Convert MongoDB extended JSON format to Mongoose format
      const convertDocument = (doc) => {
        const converted = { ...doc };
        
        // Convert _id from { $oid: "..." } to ObjectId
        if (converted._id && converted._id.$oid) {
          converted._id = new mongoose.Types.ObjectId(converted._id.$oid);
        }
        
        // Convert userId from { $oid: "..." } to ObjectId
        if (converted.userId && converted.userId.$oid) {
          converted.userId = new mongoose.Types.ObjectId(converted.userId.$oid);
        }
        
        // Convert createdAt/updatedAt from { $date: "..." } to Date
        if (converted.createdAt && converted.createdAt.$date) {
          converted.createdAt = new Date(converted.createdAt.$date);
        }
        if (converted.updatedAt && converted.updatedAt.$date) {
          converted.updatedAt = new Date(converted.updatedAt.$date);
        }
        
        // Convert teamId array
        if (Array.isArray(converted.teamId)) {
          converted.teamId = converted.teamId.map(id => {
            if (id && id.$oid) {
              return new mongoose.Types.ObjectId(id.$oid);
            }
            return id;
          });
        }
        
        // Convert tools array _id fields
        if (Array.isArray(converted.tools)) {
          converted.tools = converted.tools.map(tool => {
            if (tool._id && tool._id.$oid) {
              return { ...tool, _id: new mongoose.Types.ObjectId(tool._id.$oid) };
            }
            return tool;
          });
        }
        
        return converted;
      };

      const convertedDocuments = documents.map(convertDocument);
      console.log(`   📊 Found ${convertedDocuments.length} documents to import`);

      // Insert documents - Fast bulk insert
      try {
        // First, try bulk insert
        const result = await mapping.model.insertMany(convertedDocuments, { 
          ordered: false, // Continue even if some documents fail
          rawResult: false
        });
        console.log(`   ✅ Successfully imported ${result.length} documents into ${mapping.collection} collection`);
      } catch (error) {
        // Handle duplicate key errors
        if (error.code === 11000 || error.writeErrors) {
          const writeErrors = error.writeErrors || [];
          const duplicateCount = writeErrors.filter(err => err.code === 11000).length;
          const insertedCount = convertedDocuments.length - writeErrors.length;
          
          if (insertedCount > 0) {
            console.log(`   ✅ Imported ${insertedCount} new documents`);
          }
          
          if (duplicateCount > 0) {
            console.log(`   ⚠️  Skipped ${duplicateCount} duplicate documents (already exist)`);
          }
          
          // Try to upsert the duplicates to update them
          if (duplicateCount > 0) {
            console.log(`   🔄 Updating ${duplicateCount} existing documents...`);
            const duplicateIds = writeErrors
              .filter(err => err.code === 11000)
              .map(err => convertedDocuments[err.index]._id);
            
            const bulkOps = convertedDocuments
              .filter(doc => duplicateIds.some(id => id.equals(doc._id)))
              .map(doc => ({
                updateOne: {
                  filter: { _id: doc._id },
                  update: { $set: doc },
                  upsert: false
                }
              }));
            
            if (bulkOps.length > 0) {
              try {
                const bulkResult = await mapping.model.bulkWrite(bulkOps, { ordered: false });
                console.log(`   ✅ Updated ${bulkResult.modifiedCount} existing documents`);
              } catch (bulkError) {
                console.log(`   ⚠️  Could not update existing documents: ${bulkError.message}`);
              }
            }
          }
        } else {
          console.log(`   ❌ Error importing ${mapping.file}: ${error.message}`);
          if (error.writeErrors) {
            console.log(`   ⚠️  Write errors: ${error.writeErrors.length}`);
          }
        }
      }
    }

    console.log("\n✅ Data import completed!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error during import:", error);
    process.exit(1);
  }
};

// Run the import
importData();

