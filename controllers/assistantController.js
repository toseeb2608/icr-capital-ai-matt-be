import { StatusCodes } from "http-status-codes";
import OpenAI from "openai";
import fs from "fs";
import mime from "mime-types";
import Assistant from "../models/assistantModel.js";
import { onToolCalls } from "../utils/assistant.js";
import {
  messageListFromThread, 
  retrieveRunFromThread, 
  submitToolOutputs,
  deleteMessageFromThread,
  createMessageInThread,
  createRunForThread
} from "../lib/openai.js";
import AssistantThread from "../models/assistantThreadModel.js";
import {
  meeting_summary,
  hardDeleteAssistant,
  retrieveOpenAIFile,
  processAssistantMessage,
  retrieveOpenAIFileObject,
	getAssistantByAssistantId,
} from "../service/assistantService.js";
import User from "../models/user.js";
import * as errorMessage from "../locale/index.js";
import { AssistantMessages, CommonMessages } from "../constants/enums.js";
import {
  BadRequest,
  Conflict,
  InternalServer,
  NotFound,
} from "../middlewares/customError.js";
import { getOpenAIInstance } from "../config/openAI.js";
import { createChatPerAssistantSchema, editPromptSchema } from "../utils/validations.js";
import { handleOpenAIError } from "../utils/openAIErrors.js";
import { assistantFuncMap } from "../utils/assistantFunctionMapper.js";
import getOpenAiConfig from "../utils/openAiConfigHelper.js";
import { calculateTokenAndCost } from "../service/trackUsageService.js";
import TrackUsage from "../models/trackUsageModel.js";
import axios from "axios";
import config from "../config.js";
import FunctionDefinition from "../models/functionDefinitionModel.js";
import e from "cors";
/**
 * @function createAssistant
 * @async
 * @description Create a new assistant by attributes or retrieval from openai through assistantId
 * @param {Object} req - Request object, should contain the following properties in body: name, instructions, description,
 *     assistantId, tools, model, userId, category, imageGeneratePrompt, staticQuestions
 * @param {Object} res - Response object
 * @param {function} next - Next middleware function
 * @returns {Response} 201 - Returns assistant created message and assistant details
 * @throws {Error} Will throw an error if no assistant found or if assistant creation failed
 */
export const createAssistant = async (req, res, next) => {
  const {
    name,
    instructions,
    description,
    assistantId,
    tools: toolsString,
    model: userSelectedModel,
    userId,
    category,
    imageGeneratePrompt,
    staticQuestions,
  } = req.body;
  const files = req.files;
  let newAssistantInstance = null;

  const tools = JSON.parse(toolsString);
  const parsedTools = tools.map((tool) => ({ type: tool }));
  const dallEModel = await getOpenAiConfig("dallEModel");
  const dallEQuality = await getOpenAiConfig("dallEQuality");
  const dallEResolution = await getOpenAiConfig("dallEResolution");

  try {
    const openai = await getOpenAIInstance();

    const isNameExist = await Assistant.findOne({
      is_deleted: false,
      name: name,
    });
    if (isNameExist) {
      return next(Conflict(AssistantMessages.NAME_EXISTS));
    }

    // Handle file uploads for the new assistant
    const filePromises = files.map(async (file) => {
      const uploadedFile = await openai.files.create({
        file: fs.createReadStream(file.path),
        purpose: "assistants",
      });

      return uploadedFile.id;
    });

    // TODO: Handle promises here. If one promise is rejected then the entire promises will be rejected
    const newFileIds = await Promise.all(filePromises);


    let image_url = null;

    //Under progress
    // Based on the assistant name and model it will generate an image
    // const imageResponse = await openai.images.generate({
    // 	model: dallEModel,
    // 	prompt: name,
    // 	n: 1,
    // 	quality : dallEModel == "dall-e-3" ? dallEQuality : undefined,
    // 	size: dallEResolution,
    // });

    // image_url = imageResponse.data[0].url;
    // if assistantId is given, then we have to retrieve the assistant and create it in our database
    if (assistantId) {
      // check if already an assistant exists with the given assistantId
      const existingAssistant = await Assistant.findOne({
        assistant_id: assistantId,
      });
      if (existingAssistant)
        return next(Conflict(AssistantMessages.ASSISTANT_ALREADY_EXISTS));

      const myAssistant = await openai.beta.assistants.retrieve(assistantId);
      if (myAssistant) {
        const assistantFileIds = myAssistant?.tool_resources?.code_interpreter?.file_ids;
        newAssistantInstance = new Assistant({
          assistant_id: myAssistant.id,
          name: myAssistant.name,
          model: myAssistant.model,
          instructions: myAssistant.instructions,
          file_ids: assistantFileIds,
          tools: myAssistant.tools,
          userId: userId,
          category: category,
          description: description,
          image_url: image_url,
          static_questions: staticQuestions
            ? parseStaticQuestions(staticQuestions)
            : [],
        });
      }
    } else {
      const functions = [
        {
          type: "function",
          function: {
            name: "meeting_summary",
            description: "meeting_summary",
            parameters: {
              type: "object",
              properties: {}
            }
          }
        },
        {
          type: "function",
          function: {
            name: "query_for_get_data",
            description: "query_for_get_data",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "SQL query for postgreSQL."
                }
              },
              required: ["query"]
            }
          }
        },
        {
          type: "function",
          function: {
            name: "query_for_create_data",
            description: "query_for_create_data",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "SQL query for postgreSQL."
                }
              },
              required: ["query"]
            }
          }
        },
        {
          type: "function",
          function: {
            name: "query_for_update_data",
            description: "query_for_update_data",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "SQL query for postgreSQL."
                }
              },
              required: ["query"]
            }
          }
        },
        {
          type: "function",
          function: {
            name: "query_for_delete_data",
            description: "query_for_delete_data",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "SQL query for postgreSQL."
                }
              },
              required: ["query"]
            }
          }
        }
      ];
      // create new assistant and save it in our database
      const assistant = await openai.beta.assistants.create({
        name,
        instructions,
        // without functions 
        // tools: parsedTools,
        // model: userSelectedModel || "gpt-4-1106-preview",
        // tool_resources:{'code_interpreter': {'file_ids': newFileIds}},
        // with functions
        tools: [
          // { type: "code_interpreter"},
          ...functions  // Spread your predefined functions here
        ],
        model: userSelectedModel || "gpt-4-1106-preview",
        //file_ids: newFileIds,
      });


      if (assistant) {
        const assistantFileIds = assistant?.tool_resources?.code_interpreter?.file_ids;
        newAssistantInstance = new Assistant({
          assistant_id: assistant.id,
          name: assistant.name,
          model: assistant.model,
          instructions: assistant.instructions,
          tools: assistant.tools,
          file_ids: assistantFileIds,
          userId: userId,
          category: category,
          description: description,
          image_url: image_url,
          static_questions: staticQuestions
            ? parseStaticQuestions(staticQuestions)
            : [],
        });
      }
    }

    if (newAssistantInstance) {
      // Delete the uploaded files from the temporary directory
      files.forEach((file) => {
        fs.unlink(file.path, (err) => {
          if (err) {
            console.error(`Error deleting file: ${file.path}`, err);
          }
        });
      });

      // Save the new assistant instance to the database
      newAssistantInstance.model = userSelectedModel; // Save the user-selected model
      const result = await newAssistantInstance.save();

      if (result) {
        res.status(StatusCodes.CREATED).json({
          message: AssistantMessages.ASSISTANT_CREATED_SUCCESSFULLY,
          assistant: newAssistantInstance,
        });
      }
    } else {
      return next(InternalServer(AssistantMessages.ASSISTANT_CREATION_FAILED));
    }
  } catch (error) {
    console.log(error);
    if (error instanceof OpenAI.APIError) {
      const customOpenAIError = handleOpenAIError(error);
      return next(customOpenAIError);
    }
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message: error.message,
    });
  }
};

/**
 * @async
 * @function createChatPerAssistant
 * @description Create a new chat for an assistant
 * @param {Object} req - Request object. Should contain the following parameters in body: { question, thread_id [= false] }
 * @param {Object} res - Response object
 * @param {function} next - Next middleware function
 * @returns {Response} 201 - Returns created chat and thread ID
 * @throws {Error} Will throw an error if chat creation failed
 */


export const createChatPerAssistant = async (req, res, next) => {
  console.time("Total Execution Time");

  const { _id: userId } = req.user;
  const { assistant_id } = req.params;
  const { question, thread_id = null } = req.body;
  let threadId = thread_id;

  const validationResult = createChatPerAssistantSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (validationResult.error) {
    console.timeEnd("Total Execution Time");
    return next(
      BadRequest("The message you submitted was too long, please reload and try again.")
    );
  }

  try {
    console.time("OpenAI Setup");
    const openai = await getOpenAIInstance();
    console.timeEnd("OpenAI Setup");

    console.time("Fetch Assistant");
    const assistant = await getAssistantByAssistantId(assistant_id);
    console.timeEnd("Fetch Assistant");

    if (!assistant) {
      console.timeEnd("Total Execution Time");
      return next(NotFound(AssistantMessages.ASSISTANT_NOT_FOUND));
    }

    // 🔧 Get the OpenAI assistant to check model and tools
    console.time("Retrieve OpenAI Assistant");
    let openaiAssistant;
    try {
      openaiAssistant = await openai.beta.assistants.retrieve(assistant_id);
    } catch (err) {
      console.error("Error retrieving OpenAI assistant:", err);
      console.timeEnd("Total Execution Time");
      return next(BadRequest("Failed to retrieve assistant configuration."));
    }
    console.timeEnd("Retrieve OpenAI Assistant");

    // 🛡️ Check and fix model-tool compatibility
    const currentModel = openaiAssistant.model;
    const currentTools = openaiAssistant.tools || [];
    
    // Check if o3-mini is being used with incompatible tools
    const hasCodeInterpreter = currentTools.some(tool => tool.type === 'code_interpreter');
    const hasFileSearch = currentTools.some(tool => tool.type === 'file_search');
    const isO3Mini = currentModel === 'o3-mini';
    
    if (isO3Mini && (hasCodeInterpreter || hasFileSearch)) {
      
      try {
        console.time("Update Assistant Tools");
        // Remove incompatible tools for o3-mini (both code_interpreter and file_search)
        const filteredTools = currentTools.filter(tool => 
          tool.type !== 'code_interpreter' && tool.type !== 'file_search'
        );
        
        // Update the assistant to remove incompatible tools
        await openai.beta.assistants.update(assistant_id, {
          tools: filteredTools
        });
        
        // Update local assistant object for this request
        openaiAssistant.tools = filteredTools;
        console.timeEnd("Update Assistant Tools");
        
        
        // Log which tools were removed for debugging
        if (hasCodeInterpreter) {
          console.log("Removed code_interpreter tool for o3-mini compatibility");
        }
        if (hasFileSearch) {
          console.log("Removed file_search tool for o3-mini compatibility");
        }
        
      } catch (updateErr) {
        console.error("Error updating assistant tools:", updateErr);
        console.timeEnd("Total Execution Time");
        return next(BadRequest("Failed to update assistant for model compatibility. Please update the assistant configuration."));
      }
    }

    let runId;
    let run;
    let createdThread;

    // 🧠 If no thread_id, create thread + message and immediately start run
    if (!threadId) {
      try {
        console.time("Create Thread & Message");
        createdThread = await openai.beta.threads.create({
          messages: [{ role: "user", content: question }],
        });
        threadId = createdThread?.id;
        console.timeEnd("Create Thread & Message");

        if (!threadId) throw new Error("Thread creation failed");

        // Save thread to DB
        console.time("Save Thread");
        await new AssistantThread({
          assistant_id,
          user: userId,
          thread_id: threadId,
          title: question.substring(0, 50),
        }).save();
        console.timeEnd("Save Thread");
      } catch (err) {
        console.error("Error creating thread+message:", err);
        console.timeEnd("Total Execution Time");
        return next(BadRequest("Failed to create conversation thread."));
      }
    } else {
      // Add message to existing thread
      console.time("Create Message");
      await openai.beta.threads.messages.create(threadId, {
        role: "user",
        content: question,
      });
      console.timeEnd("Create Message");
    }

    // 🔁 Start the run with validated assistant
    try {
      console.time("Create Run");
      run = await openai.beta.threads.runs.create(threadId, {
        assistant_id,
        // Optionally, you can explicitly pass the tools to ensure compatibility
        // tools: openaiAssistant.tools
      });
      runId = run?.id;
      console.timeEnd("Create Run");

      if (!runId) throw new Error("Run creation failed");
    } catch (err) {
      console.error("Error creating run:", err);
      
      // Check if it's still a model compatibility error
      if (err.message && err.message.includes("cannot be used with")) {
        console.timeEnd("Total Execution Time");
        return next(BadRequest("Model compatibility issue detected. Please update the assistant configuration and try again."));
      }
      
      console.timeEnd("Total Execution Time");
      return next(BadRequest("Failed to initiate assistant response from OpenAI."));
    }

    // 🪄 Optional: If using polling (can be replaced with webhooks later)
    let retrieveRun;
    try {
      console.time("Retrieve Run");
      retrieveRun = await retrieveRunFromThread(openai, threadId, runId);
      console.timeEnd("Retrieve Run");
    } catch (err) {
      console.error("Initial run status check failed:", err);
      console.timeEnd("Total Execution Time");
      return next(BadRequest("Failed to check run status."));
    }

    let openAIErrorFlag = false;
    while (retrieveRun.status !== "completed") {
      // console.log(`Run status: ${retrieveRun.status}`);

      if (["failed", "cancelled", "expired"].includes(retrieveRun.status)) {
        openAIErrorFlag = true;
        break;
      }

      if (retrieveRun.status === "requires_action") {
        try {
          const runWithToolCall = await retrieveRunFromThread(openai, threadId, runId);
          const toolCalls = runWithToolCall.required_action.submit_tool_outputs.tool_calls;

          const toolOutputs = await onToolCalls(assistant_id, toolCalls, assistant.functionCalling);
          await submitToolOutputs(openai, threadId, runId, toolOutputs);
        } catch (err) {
          console.error("Error handling tool calls:", err);
          openAIErrorFlag = true;
          break;
        }
      }

      await new Promise((res) => setTimeout(res, 1000));
      retrieveRun = await retrieveRunFromThread(openai, threadId, runId);
    }

    if (openAIErrorFlag) {
      console.timeEnd("Total Execution Time");
      return next(BadRequest("Assistant failed to complete the response."));
    }

    try {
      console.time("Fetch Messages");
      const threadMessages = await messageListFromThread(openai, threadId);
      console.timeEnd("Fetch Messages");

      const finalMsg = threadMessages.data.find(
        (msg) => msg.run_id === runId && msg.role === "assistant"
      );

      if (finalMsg) {
        console.timeEnd("Total Execution Time");
        return res.status(201).json({
          response: await processAssistantMessage(finalMsg),
          msg_id: finalMsg.id,
          thread_id: threadId,
        });
      }

      return res.status(500).json({ message: AssistantMessages.SOMETHING_WENT_WRONG });
    } catch (err) {
      console.error("Message retrieval error:", err);
      console.timeEnd("Total Execution Time");
      return next(BadRequest("OpenAI did not return a valid assistant message."));
    }
  } catch (err) {
    console.error("Unexpected error:", err);
    console.timeEnd("Total Execution Time");
    return next(err);
  }
};

/**
 * @async
 * @function getAllAssistants
 * @description Get a list of assistants with optional category filter and pagination
 * @param {Object} req - The request object. Query string may contain 'page' and 'limit' parameters for pagination
 * @param {Object} res - The response object
 * @throws {Error} Will throw an error if it fails to fetch the assistants
 * @returns {Response} 200 - Returns assistants list and total assistant count
 */
export const getAllAssistants = async (req, res) => {
  try {
    const { page = 1, limit = 10, searchQuery = "" } = req.query;

    console.log("page:", page, "Limit:", limit);

    //openai init
    const openai = await getOpenAIInstance();

    // Define the query object with the is_deleted condition
    const query = { is_deleted: false, category: "ORGANIZATIONAL" };

    if (typeof searchQuery === "string" && searchQuery?.length) {
      query.$or = [{ name: { $regex: new RegExp(searchQuery, "i") } }];
    }

    const totalAssistantCount = await Assistant.countDocuments(query);

    // Find assistants based on the query
    const assistants = await Assistant.find(query)

      .populate({
        path: "userId",
        model: "User",
        select: "fname",
      })

      .populate("teamId")
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(limit)
      .lean();

    // Iterate over each assistant and fetch filenames for file_ids
    for (const assistant of assistants) {
      const fileNames = await Promise.all(
        assistant.file_ids.map(async (fileId) => {
          const fileInfo = await openai.files.retrieve(fileId);
          return fileInfo.filename;
        })
      );
      // Update the assistant object with fileNames
      assistant.fileNames = fileNames;
    }

    res.status(StatusCodes.OK).json({
      assistants,
      totalAssistantCount,
      message: AssistantMessages.ASSISTANT_FETCHED_SUCCESSFULLY,
    });
  } catch (error) {
    console.log(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message: error.message,
    });
  }
};

/**
 * @async
 * @function getAssistantById
 * @description Get assistant by id
 * @param {Object} req - The request object. The params should contain the assistant ID
 * @param {Object} res - The response object
 * @throws {Error} Will throw an error if it fails to fetch the assistant
 * @returns {Response} 200 - Returns fetched assistant
 */
export const getAssistantById = async (req, res) => {
  try {
    const { id: assistant_id } = req.params;

    //openai init
    const openai = await getOpenAIInstance();
    // console.log(assistant_id, "assistant_id");

    // Find assistants based on the query
    const assistant = await Assistant.findOne({ assistant_id })
      .populate({
        path: "userId",
        select: "fname lname",
      })
      .lean();

    if (!assistant) {
      return next(NotFound(AssistantMessages.ASSISTANT_NOT_FOUND));
    }

    // Check if the assistant has file_ids
    if (assistant.file_ids && assistant.file_ids.length > 0) {
      // Iterate over each assistant and fetch filenames for file_ids
      const fileNames = await Promise.all(
        assistant.file_ids.map(async (fileId) => {
          const fileInfo = await openai.files.retrieve(fileId);
          return fileInfo.filename;
        })
      );

      // Update the assistant object with fileNames
      assistant.fileNames = fileNames;
    } else {
      // Set an empty array for fileNames if file_ids is not present
      assistant.fileNames = [];
    }

    res.status(StatusCodes.OK).json({
      assistant,
      message: AssistantMessages.ASSISTANT_FETCHED_SUCCESSFULLY,
    });
  } catch (error) {
    console.log(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message: error.message,
    });
  }
};

/**
 * @async
 * @function getAllUserAssistantStats
 * @description Get statistics of assistants for all users with pagination
 * @param {Object} req - The request object. The query may contain 'page' and 'limit' parameters for pagination
 * @param {Object} res - The response object
 * @throws {Error} Will throw an error if it fails to fetch the statistics
 * @returns {Response} 200 - Returns statistics of assistants for all users
 */
export const getAllUserAssistantStats = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;

    // Use Aggregation Framework for counting
    const userStats = await Assistant.aggregate([
      {
        $match: {
          userId: { $exists: true, $ne: null },
          is_deleted: false,
          category: "PERSONAL",
        },
      },
      {
        $group: {
          _id: "$userId",
          totalAssistants: { $sum: 1 },
          activeAssistants: {
            $sum: {
              $cond: [{ $eq: ["$is_active", true] }, 1, 0],
            },
          },
        },
      },
      {
        $lookup: {
          from: "users", // Collection name for the User model
          localField: "_id",
          foreignField: "_id",
          as: "userDetails",
        },
      },
      {
        $unwind: "$userDetails",
      },
      {
        $project: {
          _id: 1,
          username: "$userDetails.fname",
          totalAssistants: 1,
          activeAssistants: 1,
          status: "$userDetails.status",
        },
      },
      { $sort: { totalAssistants: -1 } },
      { $skip: (page - 1) * limit },
      // { $limit: limit },
    ]);

    res.status(StatusCodes.OK).json({
      userStats,
      message: AssistantMessages.ASSISTANT_STATS_FETCHED_SUCCESSFULLY,
    });
  } catch (error) {
    console.log(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message: error.message,
    });
  }
};

/**
 * @async
 * @function getAssistantsCreatedByUser
 * @description Get assistants created by a specific user with a given category, considering pagination
 * @param {Object} req - The request object. Expected params: userId. Expected query: page, pageSize
 * @param {Object} res - The response object
 * @throws {Error} Will throw an error if it fails to fetch the assistants
 * @returns {Response} 200 - Returns a list of assistants created by the user
 */
export const getAssistantsCreatedByUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, pageSize = 10, searchQuery = "" } = req.query;

    //openai init
    const openai = await getOpenAIInstance();

    const skip = (Number(page) - 1) * Number(pageSize);
    const limit = parseInt(pageSize);

    const query = {
      userId: userId,
      category: "PERSONAL", // Filter by category "PERSONAL"
      is_deleted: false,
      //  is_active: true
    };

    if (typeof searchQuery === "string" && searchQuery?.length) {
      query.$or = [{ name: { $regex: new RegExp(searchQuery, "i") } }];
    }

    const [assistants, totalCount] = await Promise.all([
      Assistant.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Assistant.countDocuments(query),
    ]);

    // Iterate over each assistant and fetch filenames for file_ids
    for (const assistant of assistants) {
      try {
        const fileNames = await Promise.all(
          assistant.file_ids.map(async (fileId) => {
            try {
              const fileInfo = await openai.files.retrieve(fileId);
              return fileInfo.filename;
            } catch (fileError) {
              console.error(
                `Error retrieving file ${fileId}: ${fileError.message}`
              );
              return null; // Handle file retrieval error gracefully
            }
          })
        );

        // Update the assistant object with fileNames
        assistant.fileNames = fileNames;
      } catch (error) {
        console.error(
          `Error processing assistant ${assistant._id}: ${error.message}`
        );
        // Handle assistant processing error gracefully
      }
    }

    res.status(StatusCodes.OK).json({
      assistants,
      totalCount,
      message: AssistantMessages.ASSISTANT_FETCHED_SUCCESSFULLY,
    });
  } catch (error) {
    console.log(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message: error.message,
    });
  }
};

/**
 * @async
 * @function getAllUserAssignedAssistants
 * @description Get a list of assistants that are assigned to the user
 * @param {Object} req - The request object. Expected params: none. Expected query: pageSize, page. Request object should contain user details
 * @param {Object} res - The response object
 * @throws {Error} Will throw an error if it fails to fetch the assistants
 * @returns {Response} 200 - Returns a list of assistants assigned to the user including pagination details
 */
export const getAllUserAssignedAssistants = async (req, res) => {
  const { _id: user_id } = req.user;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const currentPage = parseInt(req.query.page) || 1;

  const searchQuery = req.query.searchQuery || "";
  const searchConditionOnName = { $regex: new RegExp(searchQuery, "i") };

  try {
    const reqUser = await User.findById(user_id).populate("teams");

    if (!reqUser) {
      return next(BadRequest(AssistantMessages.USER_DOES_NOT_EXIST));
    }
    let query = {};
    let notDeletedAndActive = { is_deleted: false, is_active: true };
    let getPersonalAssistant = {
      ...notDeletedAndActive,
      userId: reqUser._id,
      category: "PERSONAL",
    };

    if (reqUser.role === "superadmin") {
      // Query for superadmin to fetch all active organizational assistants and personal created assistants
      query = {
        $or: [
          {
            ...notDeletedAndActive,
            category: "ORGANIZATIONAL",
            name: searchConditionOnName,
          }, // Organizational assistants
          { ...getPersonalAssistant, name: searchConditionOnName }, // Personal created assistants by the user
        ],
      };
    } else if (reqUser.teams.length) {
      // Query for normal user to fetch organizational assistants for the user's team and personal created assistants
      query = {
        $or: [
          {
            ...notDeletedAndActive,
            teamId: { $in: reqUser.teams },
            category: "ORGANIZATIONAL",
            name: searchConditionOnName,
          }, // Organizational assistants for the user's team
          { ...getPersonalAssistant, name: searchConditionOnName }, // Personal created assistants by the user
        ],
      };
    } else if (!reqUser.teams.length) {
      return res.status(StatusCodes.OK).json({ assistants: [] });
    }

    const [assistants, totalCount] = await Promise.all([
      Assistant.find(query)
        .skip((currentPage - 1) * pageSize)
        .limit(pageSize)
        .sort({ createdAt: -1 }),
      Assistant.countDocuments(query),
    ]);

    const totalPages = Math.ceil(totalCount / pageSize);

    console.log(
      "totalPages:",
      totalPages,
      "totalCount:",
      totalCount,
      "pageSize:",
      pageSize,
      "Assistants:"
      // assistants
    );
    return res.status(StatusCodes.OK).json({
      assistants,
      totalPages,
      message: AssistantMessages.ASSISTANT_FETCHED_SUCCESSFULLY,
    });
  } catch (error) {
    console.log(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message: error.message,
    });
  }
};

/**
 * @async
 * @function getAllAssistantsByPagination
 * @description Get list of assistants that are assigned to the user with pagination
 * @param {Object} req - The request object. Expected params: none. Expected query: pageSize, page. Request object should contain user details
 * @param {Object} res - The response object
 * @throws {Error} Will throw an error if it fails to fetch the assistants
 * @returns {Response} 200 - Returns a list of assistants assigned to the user including pagination details
 */
export const getAllAssistantsByPagination = async (req, res) => {
  const { _id: user_id } = req.user;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const currentPage = parseInt(req.query.page) || 1;
  try {
    let query = {};
    const reqUser = await User.findById(user_id);

    if (!reqUser) {
      return next(BadRequest(AssistantMessages.USER_DOES_NOT_EXIST));
    }
    const totalAssistants = await Assistant.find({ is_deleted: false });
    const totalPages = Math.ceil(totalAssistants.length / pageSize);

    if (reqUser.teamId) {
      query.teamId = reqUser.teamId;
    } else if (reqUser.role !== "superadmin") {
      return res.status(StatusCodes.OK).json({ assistants: [] });
    }

    const allAssistants = await Assistant.find({ is_deleted: false })
      .skip((currentPage - 1) * pageSize + 3)
      .limit(pageSize)
      .sort({ createdAt: -1 });

    res.status(StatusCodes.OK).json({
      allAssistants,
      currentPage,
      totalPages,
      message: AssistantMessages.ASSISTANT_FETCHED_SUCCESSFULLY,
    });
  } catch (error) {
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message: error.message,
    });
  }
};

/**
 * @async
 * @function getChatPerAssistant
 * @description Get all chats for a specific assistant by the user
 * @param {Object} req - The request object. Expected params: assistant_id. Expected query: thread_id (required), limit, after, before.
 * @param {Object} res - The response object
 * @throws {Error} Will throw an error if it fails to fetch the chat
 * @returns {Response} 200 - Returns chat messages and metadata
 */
export const getChatPerAssistant = async (req, res, next) => {
  const { _id: user_id } = req.user;
  const { assistant_id } = req.params;
  const { thread_id, limit, after, before } = req.query;

  if (!thread_id) {
    return next(BadRequest(AssistantMessages.ASSISTANT_THREAD_NOT_FROUND));
  }

  let messages = [],
    metadata = { first_id: null, last_id: null, has_more: false };

  let query = {
    order: "desc", // changing order in future will require change in formatting data at line 239
    limit: limit || 20,
  };

  if (after) {
    query.after = after;
  }

  if (before) {
    query.before = before;
  }

  try {
    const existingThread = await AssistantThread.findOne({
      assistant_id,
      user: user_id,
      thread_id,
    }).lean();

    if (existingThread) {
      // console.log(existingThread);
      // initialize openai to retrieve messages
      const openai = await getOpenAIInstance();

      const threadMessages = await openai.beta.threads.messages.list(
        existingThread.thread_id,
        query
      );
      if (threadMessages.data) {
        // First, sort messages by creation time to ensure proper chronological order
        const sortedMessages = threadMessages.data.sort((a, b) => a.created_at - b.created_at);
        
        messages = [];
        let currentUserMessage = null;
        
        for (const message of sortedMessages) {
          const { id, created_at, role, content } = message;

          if (content.length === 0) continue;

          if (role === "user") {
            // Store the user message to pair with the next assistant message
            currentUserMessage = {
              msg_id: id,
              chatPrompt: content[0]?.text?.value,
              created_at: new Date(created_at * 1000).toISOString(),
            };
          } else if (role === "assistant" && currentUserMessage) {
            // Pair the current user message with this assistant message
            const formattedResponse = await processAssistantMessage(message);
            messages.unshift({
              ...currentUserMessage,
              botMessage: formattedResponse,
            });
            currentUserMessage = null; // Reset after pairing
          }
        }
        
        // Handle case where there's a trailing user message without an assistant response
        if (currentUserMessage) {
          messages.unshift({
            ...currentUserMessage,
            botMessage: "", // No response yet
          });
        }

        metadata = {
          first_id: threadMessages.body?.first_id,
          last_id: threadMessages.body?.last_id,
          has_more: !!threadMessages.body?.has_more,
        };
      }
    }

    res.status(StatusCodes.OK).json({ messages: messages, metadata });
  } catch (error) {
    console.log(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message: error.message,
    });
  }
};

/**
 * Downloads a file via the assistant interface given a file ID.
 * @async
 * @function downloadAssistantFile
 * @description Handles the file download process by sending the file to the client as an HTTP attachment.
 * @param {Object} req - The HTTP request object with params containing 'file_id'.
 * @param {Object} res - The HTTP response object used to send back the downloaded file.
 * @param {Function} next - The middleware function to handle the next operation in the stack.
 * @throws {Error} Will throw an error if the download operation or file retrieval fails.
 */
export const downloadAssistantFile = async (req, res, next) => {
  try {
    const { file_id } = req.params;
    const openai = await getOpenAIInstance();

    // Retrieve the file metadata to get the filename
    const fileMetadata = await openai.files.retrieve(file_id);

    // Retrieve the file content
    const fileContentResponse = await openai.files.content(file_id);

    if (fileContentResponse) {
      const buffer = await fileContentResponse.arrayBuffer();
      const bufferData = Buffer.from(buffer);
      const filename = fileMetadata.filename || "download.pdf";
      const mimeType = mime.lookup(filename) || "application/octet-stream";

      res.writeHead(StatusCodes.OK, {
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Type": mimeType,
        "Access-Control-Expose-Headers": "Content-Disposition",
      });

      res.end(bufferData);
    } else {
      // Incase fileContentResponse doesn't have data
      return res
        .status(StatusCodes.NOT_FOUND)
        .send(AssistantMessages.ASSISTANT_FILE_NOT_FOUND_MESSAGE);
    }
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      return res
        .status(StatusCodes.INTERNAL_SERVER_ERROR)
        .send(AssistantMessages.ASSISTANT_FILE_DOWNLOAD_ERROR_MESSAGE);
    }
  }
};

/**
 * @async
 * @function updateAssistantFiles
 * @description Update the file associations of specific assistant
 * @param {Object} req - The request object. Expected params: assistant_id. Files in request object body
 * @param {Object} res - The response object
 * @throws {Error} Will throw an error if it fails to update the assistant
 * @returns {Response} 201 - Returns successfully updated assistant
 */
export const updateAssistantFiles = async (req, res, next) => {
  const { assistant_id } = req.params;
  const files = req.files;

  try {
    const existingAssistant = await Assistant.findOne({ assistant_id });

    // TODO: Handle the case when the assistant is not found in a separate function
    if (!existingAssistant) {
      next(NotFound(AssistantMessages.ASSISTANT_NOT_FOUND));
      return;
    }

    const openai = await getOpenAIInstance();

    const myAssistant = await openai.beta.assistants.retrieve(assistant_id);

    let fileIds = [...myAssistant.file_ids];

    /*
        You can attach a maximum of 20 files per Assistant, and they can be at most 512 MB each.
        ref: https://platform.openai.com/docs/assistants/how-it-works/creating-assistants
         */
    if (fileIds.length === 20 || fileIds.length + files.length >= 20) {
      return next(BadRequest(AssistantMessages.FILES_AND_PROPERTIES_UPDATED));
    }

    if (files) {
      const filePromises = files.map(async (file) => {
        const uploadedFile = await openai.files.create({
          file: fs.createReadStream(file.path),
          purpose: "assistants",
        });

        return uploadedFile.id;
      });

      fileIds = [...fileIds, ...(await Promise.all(filePromises))];

      // Delete the uploaded files from the "docs" directory
      files.forEach((file) => {
        fs.unlink(file.path, (err) => {
          if (err) {
            console.error(`Error deleting file: ${file.path}`, err);
          }
        });
      });
    }

    const myUpdatedAssistant = await openai.beta.assistants.update(
      assistant_id,
      {
        file_ids: [...fileIds],
      }
    );

    if (myUpdatedAssistant) {
      existingAssistant.file_ids = fileIds;
      existingAssistant.save();
    }

    res.status(StatusCodes.CREATED).json({
      message: AssistantMessages.FILES_UPDATED,
      assistant: myAssistant,
    });
  } catch (error) {
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message: CommonMessages.INTERNAL_SERVER_ERROR,
    });
  }
};

/**
 * @async
 * @function assignTeamToAssistant
 * @description Assign a team to an assistant
 * @param {Object} req - The request object. Expected params: assistant_id. Expected body: teamIds
 * @param {Object} res - The response object
 * @throws {Error} Will throw an error if it fails to assign the team to the assistant
 * @returns {Response} 200 - Returns success message and result of the operation
 */
export const assignTeamToAssistant = async (req, res, next) => {
  const { assistant_id } = req.params;
  const { teamIds } = req.body;

  try {
    const isExistingAssistant = await Assistant.findOne({
      _id: assistant_id,
    });

    if (isExistingAssistant && Array.isArray(teamIds)) {
      isExistingAssistant.teamId = teamIds;
      const result = await isExistingAssistant.save();

      res.status(StatusCodes.OK).json({
        result,
        message: AssistantMessages.ASSISTANT_ASSIGNED_TO_TEAM,
      });
    } else {
      next(NotFound(AssistantMessages.ASSISTANT_NOT_FOUND));
      return;
    }
  } catch (error) {
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message: error.message,
    });
  }
};

/**
 * @async
 * @function updateAssistant
 * @description Perform updating fields for an existing assistant
 * @param {Object} req - The request object. Expected params: assistant_id. Assistant properties in the body
 * @param {Object} res - The response object
 * @throws {Error} Will throw an error if it fails to update the assistant
 * @returns {Response} 200 - Returns success message and result of the operation
 */
export const updateAssistant = async (req, res, next) => {
  const { assistant_id } = req.params;
  const { name, model, is_active = null } = req.body; // add more value as per the requirements

  try {
    const isExistingAssistant = await Assistant.findOne({
      _id: assistant_id,
    });

    if (isExistingAssistant) {
      isExistingAssistant.name = name || isExistingAssistant.name;
      isExistingAssistant.model = model || isExistingAssistant.model;
      isExistingAssistant.is_active =
        is_active !== null ? is_active : isExistingAssistant.is_active;

      const result = await isExistingAssistant.save();

      res.status(StatusCodes.OK).json({
        result,
        message: AssistantMessages.ASSISTANT_UPDATED_SUCCESSFULLY,
      });
      return;
    } else {
      next(NotFound(AssistantMessages.ASSISTANT_NOT_FOUND));
      return;
    }
  } catch (error) {
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message: error.message,
    });
  }
};

/**
 * @async
 * @function deleteAssistant
 * @description Delete an existing assistant
 * @param {Object} req - The request object. Expected params: assistant_id
 * @param {Object} res - The response object
 * @throws {Error} Will throw an error if it fails to delete the assistant
 * @returns {Response} 200 - Returns success message
 */
export const deleteAssistant = async (req, res, next) => {
  const { assistant_id } = req.params;

  try {
    const openai = await getOpenAIInstance();

    const existingAssistant = await Assistant.findOne({
      assistant_id: assistant_id,
    });

    if (!existingAssistant) {
      return res
        .status(StatusCodes.BAD_REQUEST)
        .json({ message: AssistantMessages.ASSISTANT_NOT_FOUND });
    }

    await hardDeleteAssistant(assistant_id, existingAssistant);

    res.status(StatusCodes.OK).json({
      message: errorMessage.ASSISTANT_DELETED_SUCCESSFULLY,
    });
  } catch (error) {
    console.log(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message: CommonMessages.INTERNAL_SERVER_ERROR,
    });
  }
};

/**
 * @async
 * @function updateAssistantDataWithFile
 * @description Update assistant data and associated files
 * @param {Object} req - The request object. Expected params: assistant_id. Assistant properties and files in the request body
 * @param {Object} res - The response object
 * @throws {Error} Will throw an error if it fails to update the assistant
 * @returns {Response} 201 - Returns success message and updated assistant
 */
// export const updateAssistantDataWithFile = async (req, res, next) => {
//   try {
//     const { assistant_id } = req.params;
//     const files = req.files;
//     const {
//       name,
//       instructions,
//       model,
//       tools: toolsString,
//       teamId,
//       staticQuestions,
//       category,
//       deleted_files,
//       description,
//     } = req.body;

//     const openai = await getOpenAIInstance();

//     const existingAssistant = await Assistant.findOne({ assistant_id });

//     if (!existingAssistant) {
//       return res.status(StatusCodes.NOT_FOUND).json({
//         message: AssistantMessages.ASSISTANT_NOT_FOUND,
//       });
//     }

//     const myAssistant = await openai.beta.assistants.retrieve(assistant_id);
//     const assistantFileIds = myAssistant.tool_resources.code_interpreter.file_ids;
//     let fileIds = [];
//     if(assistantFileIds){
//       fileIds = [...assistantFileIds];      
//     }

//     if (deleted_files) {
//       fileIds = await deleteAssistantFilesAndFilterIds(
//         openai,
//         assistant_id,
//         fileIds,
//         JSON.parse(deleted_files)
//       );
//     }

//     if (
//       fileIds.length === 20 ||
//       (files && (fileIds.length + files.length >= 20))
//     ) {
//       return res.status(StatusCodes.BAD_REQUEST).json({
//         message: AssistantMessages.FILE_LIMIT_REACHED,
//       });
//     }

//     if (files) {
//       let purpose = 'fine-tune';
//       fileIds = [...fileIds, ...(await uploadFiles(openai, files, purpose))];
//       console.log(fileIds, ' FileIds');

//       //delete files from temporary folder
//       files.forEach((file) => {
//         fs.unlink(file.path, (err) => {
//           if (err) {
//             console.error(`Error deleting file: ${file.path}`, err);
//           }
//         });
//       });
//     }

//     let asstTools = toolsString;
//     //if((assistant_id == process.env.ASSISTANT_ID) || (assistant_id == 'asst_fYC49EXYDuYcCdOZihghLnvi')){
//     if(assistant_id =='asst_fYC49EXYDuYcCdOZihghLnvi'){
//       asstTools = asstTools? parseToolsWithFunctions(asstTools) : [];
//       console.log(asstTools);

//     }
//     else{
//       asstTools = asstTools? parseTools(asstTools) : [];
//     }

//     const updateData = {
//       file_ids: fileIds,
//       name,
//       instructions,
//       model,
//       tools: asstTools,
//       tool_resources:{'code_interpreter': {'file_ids':fileIds}}
//     };

//     console.log(updateData)

//     const myUpdatedAssistant = await updateAssistantProperties(
//       openai,
//       assistant_id,
//       updateData
//     );

//     if (myUpdatedAssistant) {
//       const updatedAssistantFieldsObject = {
//         file_ids: fileIds,
//         name: myUpdatedAssistant.name,
//         instructions: myUpdatedAssistant.instructions,
//         model: myUpdatedAssistant.model,
//         tools: updateData.tools,
//         static_questions: staticQuestions
//           ? parseStaticQuestions(staticQuestions)
//           : [],
//         category,
//         description,
//       };

//       if (teamId !== undefined) {
//         updatedAssistantFieldsObject.teamId = teamId;
//       }

//       Object.assign(existingAssistant, updatedAssistantFieldsObject);

//       await existingAssistant.save();
//     }

//     res.status(StatusCodes.CREATED).json({
//       message: AssistantMessages.FILES_AND_PROPERTIES_UPDATED,
//       assistant: existingAssistant,
//     });
//   } catch (error) {
//     console.log(error)
//     if (error instanceof OpenAI.APIError) {
//       const customOpenAIError = handleOpenAIError(error);
//       return next(customOpenAIError);
//     }
//     res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
//       message: error.message,
//     });
//   }
// };

const safeGet = (obj, path) => {
  return path.split('.').reduce((acc, part) => acc && acc[part], obj);
};

// Function to upload a single file
async function uploadSingleFile(openai, file, purpose) {
  console.log('Uploading file:', file.filename);

  console.log('File path:', file.path);

  try {
    if (!fs.existsSync(file.path)) {
      throw new Error(`File does not exist at path: ${file.path}`);
    }

    const fileStream = fs.createReadStream(file.path);
    console.log('File stream created');

    const response = await openai.files.create({
      file: fileStream,
      purpose: purpose
    });

    console.log('File uploaded successfully. File ID:', response.id);
    return response.id;
  } catch (error) {
    console.error(`Error uploading file ${file.filename}:`, error);
    throw error;
  }
}

// Function to upload multiple files
async function uploadFineTuneFiles(openai, files, purpose) {
  const uploadedFileIds = [];
  for (const file of files) {
    try {
      const fileId = await uploadSingleFile(openai, file, purpose);
      uploadedFileIds.push(fileId);
    } catch (error) {
      console.error(`Failed to upload file ${file.filename}:`, error.message);
    }
  }
  return uploadedFileIds;
}

export const updateAssistantDataWithFile = async (req, res, next) => {
  try {
    const { assistant_id } = req.params;
    const files = req.files;    
    const {
      name,
      instructions,
      model,
      tools: toolsString,
      teamId,
      staticQuestions,
      category,
      deleted_files,
      description,
    } = req.body;

    console.log('Received files:', files ? files.map(f => ({ filename: f.filename, path: f.path })) : 'No files');

    const openai = await getOpenAIInstance();

    const existingAssistant = await Assistant.findOne({ assistant_id });

    if (!existingAssistant) {
      return res.status(StatusCodes.NOT_FOUND).json({
        message: AssistantMessages.ASSISTANT_NOT_FOUND,
      });
    }

    const myAssistant = await openai.beta.assistants.retrieve(assistant_id);
    const assistantFileIds = safeGet(myAssistant, 'tool_resources.code_interpreter.file_ids') || [];
    let fileIds = [...assistantFileIds];

    if (deleted_files) {
      fileIds = await deleteAssistantFilesAndFilterIds(
        openai,
        assistant_id,
        fileIds,
        JSON.parse(deleted_files)
      );
    }

    if (fileIds.length === 20 || (files && (fileIds.length + files.length > 20))) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        message: AssistantMessages.FILE_LIMIT_REACHED,
      });
    }

    if (files && files.length > 0) {
      console.log('Attempting to upload files:', files.length);
      const uploadedFileIds = await uploadFineTuneFiles(openai, files, 'assistants');
      fileIds = [...fileIds, ...uploadedFileIds];
      console.log('Uploaded file IDs:', uploadedFileIds);

      // Delete files from temporary folder
      for (const file of files) {
        try {
          await fs.promises.unlink(file.path);
          console.log(`Deleted original file: ${file.path}`);
        } catch (deleteError) {
          console.error(`Failed to delete original file ${file.path}:`, deleteError.message);
        }
      }
    }

    let asstTools = toolsString;
    // if (assistant_id === config.ASSISTANT_ID) {
    //   asstTools = asstTools ? parseToolsWithFunctions(asstTools) : [];
    // } else {
      asstTools = asstTools ? parseToolsWithFunctions(asstTools) : [];
    // }

    const updateData = {
      file_ids: fileIds,
      name,
      instructions,
      model,
      tools: asstTools,
      tool_resources: { 'code_interpreter': { 'file_ids': fileIds } }
    };

    // Add reasoning_effort only for o1-mini model
    if (model === 'o3-mini') {
      updateData.reasoning_effort = 'medium';
      updateData.temperature = null;
      updateData.top_p = null;
      updateData.response_format = null;
    }
    else
    {
      updateData.reasoning_effort = null;
    }

    const myUpdatedAssistant = await updateAssistantProperties(
      openai,
      assistant_id,
      updateData
    );

    if (myUpdatedAssistant) {
      const updatedAssistantFieldsObject = {
        file_ids: fileIds,
        name: myUpdatedAssistant.name,
        instructions: myUpdatedAssistant.instructions,
        model: myUpdatedAssistant.model,
        tools: updateData.tools,
        static_questions: staticQuestions
          ? parseStaticQuestions(staticQuestions)
          : [],
        category,
        description,
      };

      if (teamId !== undefined) {
        updatedAssistantFieldsObject.teamId = teamId;
      }

      Object.assign(existingAssistant, updatedAssistantFieldsObject);

      await existingAssistant.save();
    }

    res.status(StatusCodes.CREATED).json({
      message: AssistantMessages.FILES_AND_PROPERTIES_UPDATED,
      assistant: existingAssistant,
    });
  } catch (error) {
    console.error('Error in updateAssistantDataWithFile:', error);
    if (error instanceof OpenAI.APIError) {
      const customOpenAIError = handleOpenAIError(error);
      return next(customOpenAIError);
    }
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message: error.message,
    });
  }
};


/** ============== UTILITY FUNCTION =================== */
const parseTools = (toolsString) => {
  try {
    return JSON.parse(toolsString).map((tool) => ({ type: tool }));
  } catch (error) {
    console.error("Error parsing tools:", error);
    throw new Error("Invalid tools format");
  }
};

/* parseToolsWithFunctions
mapping for functions  */
const parseToolsWithFunctions = (toolsString) => {
  try {
    // return JSON.parse(toolsString).map((tool) => ({ type: tool }));
    const functionsMap = assistantFuncMap;
    let funcKeys = Object.keys(functionsMap);
    let funcInd = 0;
    let toolsArr = JSON.parse(toolsString);
    // console.log(toolsArr);
    if ((toolsArr.length > 0) && (toolsArr.length < 3) && (toolsArr.indexOf('function') < 0)){
      let toolsSize = toolsArr.length;
      for (var i = 0; i < (funcKeys.length); i++) {
        toolsArr.push('function');
      }
    }
    // console.log(toolsArr);
    return toolsArr.map( (val) => {
      if(val == 'code_interpreter'){
        return { type: val};
      }
      else if ( val == 'file_search'){
        return { type: val};
      }
      else if (val == 'function'){
        if(funcKeys[funcInd] == 'meeting_summary'){
          const finalObj =  {
            type: val,
            function: {
              name: funcKeys[funcInd],
              description: funcKeys[funcInd],
            }
          };
          funcInd++;
          return finalObj;
        }
        else if((funcKeys[funcInd] != 'meeting_summary') ){ 
          const finalObj = {
            type: val,
            function: {
              name: funcKeys[funcInd],
              description: funcKeys[funcInd],
              parameters: {
                type: 'object',
                properties: {
                  'query': {type: 'string', description: 'SQL query for postgreSQL.'},
                },
                required: ['query']
              } || {},
            }
          };
          funcInd++;
          return finalObj;
        }

      }
    });
    
  } catch (error) {
    console.error("Error parsing tools with functions:", error);
    throw new Error("Invalid tools format for functions");
  }
};



const parseStaticQuestions = (staticQuestionsString) => {
  try {
    return JSON.parse(staticQuestionsString);
  } catch (error) {
    console.error("Error parsing static questions:", error);
    throw new Error("Invalid static questions format");
  }
};

const deleteAssistantFilesAndFilterIds = async (
  openai,
  assistantId,
  fileIds,
  deletedFileIds
) => {
  try {
    // will be restored when the functionality is fixed 
    for (const deletedFileId of deletedFileIds) {
      console.log(deletedFileId, 'deleted file');
      console.log(assistantId, 'assistant id');
      await openai.files.del(deletedFileId);
    }
    return fileIds.filter((fileId) => !deletedFileIds.includes(fileId));
  } catch (error) {
    console.error("Error deleting assistant files:", error);
    throw error;
  }
};

const uploadFiles = async (openai, files, purposeText) => {
  const filePromises = files.map(async (file) => {
    const uploadedFile = await openai.files.create({
      file: fs.createReadStream(file.path),
      purpose: purposeText,
    });

    return uploadedFile.id;
  });

  return Promise.all(filePromises);
};

const updateAssistantProperties = async (openai, assistantId, updateData) => {
  return openai.beta.assistants.update(assistantId, updateData);
};

//Function Calling API's

//Helper Function
/**
 * @async
 * @function createFunctionMap
 * @description A helper function which creates new function and maps it based on the function definitions stored in the database
 * @param {Object} req - No request params
 * @param {Object} res - Response object
 * @throws {Error} Will throw an error if function creation is failed
 */
async function createFunctionMap() {
  try {
    // Get all function definitions from the database
    const definitions = await FunctionDefinition.find({});

    // Map function names to executable functions
    const functionMap = definitions.reduce((acc, def) => {
      try {
        const funcDefinition = def.definition.replace("()", "(axios)");

        const func = new Function("axios", `return async ${funcDefinition}`)(
          axios
        );

        acc[def.name] = func;
      } catch (error) {
        console.error(`Failed to compile function ${def.name}:`, error);
      }
      return acc;
    }, {});

    return functionMap;
  } catch (err) {
    console.error("Error fetching function definitions:", err);
  }
}

/**
 * @async
 * @function fetchFunctionNamesPerAssistant
 * @description Fetches function name created in the particular function calling assistant
 * @param {Object} req - Request object. Should contain the following parameter in body: { assistantName }
 * @param {Object} res - Response object
 * @returns {Response} 200 - Returns assistants function name
 * @throws {Error} Will throw an error if function not found
 */
export const fetchFunctionNamesPerAssistant = async (req, res) => {
  try {
    const { assistantName } = req.body;
    const openai = await getOpenAIInstance();
    if (
      !assistantName ||
      assistantName == "" ||
      assistantName == null ||
      assistantName == undefined
    ) {
      res.status(400).send({ message: "Assistant name required" });
    } else {
      const assistant = await Assistant.findOne({ name: assistantName });

      const myAssistant = await openai.beta.assistants.retrieve(
        assistant.assistant_id
      );

      const functionNames = myAssistant.tools.map((tool) => tool.function.name);

      res.status(200).send({ assistantFunctionName: functionNames });
    }
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * @async
 * @function functionsParametersPerFunctionName
 * @description Fetches parameter names for a specific function within an assistant
 * @param {Object} req - Request object. Should contain the following parameters in body: { assistantName, functionName }
 * @param {Object} res - Response object
 * @returns {Response} 200 - Returns an array of parameter names for the function
 * @throws {Error} Will throw an error if the assistant or function is not found
 */
export const functionsParametersPerFunctionName = async (req, res) => {
  try {
    const { assistantName, functionName } = req.body;

    const openai = await getOpenAIInstance();

    if (!assistantName || !functionName) {
      return res.status(400).send({
        message: "Both Function name and Assistant name are required",
      });
    }

    const assistant = await Assistant.findOne({ name: assistantName });

    const myAssistant = await openai.beta.assistants.retrieve(
      assistant.assistant_id
    );

    // Find the function by the given name
    const functionObj = myAssistant.tools.find(
      (tool) => tool.function.name === functionName
    );

    // Check if function with functionName exists
    if (!functionObj) {
      return res
        .status(404)
        .send({ message: `Function ${functionName} not found` });
    }

    // Extract the properties from the parameters object
    const properties = functionObj.function.parameters?.properties;
    const parametersList = properties ? Object.keys(properties) : [];

    res.status(200).send({ parametersPerFunctionName: parametersList });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * @async
 * @function validateFunctionDefinition
 * @description Validates a given function definition to ensure it is well-formed and executable
 * @param {Object} req - Request object. Should contain the following parameters in body: { functionDefinition, functionName, parameters }
 * @param {Object} res - Response object
 * @returns {Response} 200 - Returns success message if the function definition is valid
 * @throws {Error} Will throw an error if the function definition is not executable or has errors
 */
export const validateFunctionDefinition = async (req, res) => {
  try {
    const { functionDefinition, functionName, parameters } = req.body;

    if (!functionDefinition) {
      return res.status(400).send({
        message: "Function Definition is required",
      });
    }

    const funcDefinition = functionDefinition.replace("()", "(axios)");

    const func = new Function("axios", `return async ${funcDefinition}`)(axios);
    const result = func(...Object.values(parameters));
    console.log(result);

    res.status(200).send({ message: "Function is correct" });
  } catch (err) {
    console.log(err);
    res.status(500).json({
      message: err.message,
    });
  }
};

/**
 * @async
 * @function addFunctionDefinition
 * @description Adds a new function definition to the database
 * @param {Object} req - Request object. Should contain the following parameters in body: { name, definition }
 * @param {Object} res - Response object
 * @returns {Response} 201 - Returns the newly added function definition
 * @throws {Error} Will throw an error if the name or definition is missing, or if the name already exists
 */
export const addFunctionDefinition = async (req, res) => {
  try {
    const { name, definition } = req.body;
    if (!name || !definition) {
      res.status(401).send({ error: "Both fields are mandatory" });
    }

    const nameExists = await FunctionDefinition.findOne({ name });
    if (nameExists) {
      res.status(400).json({ error: "Name already exists" });
    } else {
      const newFunctionDefinition = new FunctionDefinition({
        name: name,
        definition: definition,
      });
      await newFunctionDefinition.save();
      res.status(201).send(newFunctionDefinition);
    }
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
};

/**
 * @async
 * @function getAllFunctionCallingAssistants
 * @description Retrieves all assistants that have function calling enabled and are not deleted
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @returns {Response} 200 - Returns an array of assistant names
 * @throws {Error} Will throw an error if there is an issue retrieving the assistants from the database
 */
export const getAllFunctionCallingAssistants = async (req, res) => {
  try {
    const query = {
      functionCalling: true,
      is_deleted: false,
    };

    const assistants = await Assistant.find(query).sort({ createdAt: -1 });

    // Map over the assistants and extract the names into an array
    const assistantNames = assistants.map((assistant) => assistant.name);

    res.status(StatusCodes.OK).json({ assistants: assistantNames });
  } catch (error) {
    console.error(error); // Use console.error here for better error stack tracing
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message: error.message,
    });
  }
};

/**
 * @async
 * @function getFunctionCallingAssistantsByPagination
 * @description Retrieves a paginated list of all function calling assistants
 * @param {Object} req - Request object. Can contain the following query parameters: { page, pageSize }
 * @param {Object} res - Response object
 * @returns {Response} 200 - Returns paginated result of assistants
 * @throws {Error} Will throw an error if there is an issue retrieving the assistants or processing the query
 */
export const getFunctionCallingAssistantsByPagination = async (req, res) => {
  try {
    // const { userId } = req.params;
    const { page = 1, pageSize = 10 } = req.query;

    const skip = (page - 1) * pageSize;
    const limit = parseInt(pageSize);

    const query = {
      // userId: userId,
      functionCalling: true,
      is_deleted: false,
    };

    const assistants = await Assistant.find(query)
      .skip(skip)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.status(StatusCodes.OK).json({ assistants });
  } catch (error) {
    console.log(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message: error.message,
    });
  }
};

/**
 * @async
 * @function createAssistantWithFunctionCalling
 * @description Creates a new assistant instance with function calling capability
 * @param {Object} req - Request object. Should contain various assistant attributes in the body
 * @param {Object} res - Response object
 * @returns {Response} 201 - Returns the newly created assistant instance
 * @throws {Error} Will throw an error if an assistant with the same name already exists, or if there is an issue during creation
 */
export const createAssistantWithFunctionCalling = async (req, res) => {
  try {
    const {
      name,
      instructions,
      tools, // Instead of toolsString, directly use an array of tools in req.body
      userSelectedModel,
      category = "ORGANIZATIONAL",
      description,
      userId,
    } = req.body;

    let newAssistantInstance = null;

    const openai = await getOpenAIInstance();

    // Check if an assistant with the same name and user ID already exists
    const isNameAndUserExist = await Assistant.findOne({
      is_deleted: false,
      name,
    });

    if (isNameAndUserExist) {
      return res.status(StatusCodes.CONFLICT).json({
        message: "An assistant with this name already exists for the user",
      });
    }

    const assistantTools = tools.map((tool) => {
      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters || {}, // If parameters are not provided, default to an empty object
        },
      };
    });

    const assistant = await openai.beta.assistants.create({
      instructions,
      tools: assistantTools,
      model: userSelectedModel || "gpt-4-1106-preview",
    });

    if (assistant) {
      newAssistantInstance = new Assistant({
        assistant_id: assistant.id,
        name: name,
        model: assistant.model,
        instructions: assistant.instructions,
        tools: assistant.tools,
        userId: userId,
        category: category,
        description: description,
        functionCalling: true,
      });
    }

    if (newAssistantInstance) {
      const result = await newAssistantInstance.save();

      if (result) {
        console.log("Assistant created successfully:", newAssistantInstance);
      }
    }

    res.status(StatusCodes.CREATED).json({
      message: AssistantMessages.ASSISTANT_CREATED_SUCCESSFULLY,
      assistant: newAssistantInstance,
    });
  } catch (error) {
    console.error("Error during assistant creation:", error);
    InternalServer(AssistantMessages.ASSISTANT_CREATION_FAILED);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message: "An error occurred during the creation of the assistant.",
      error: error.message,
    });
  }
};

/**
 * @async
 * @function getAssistantInfo
 * @description Retrieves information about a specific assistant by its ID
 * @param {Object} req - Request object. Should contain the assistant ID in the params
 * @param {Object} res - Response object
 * @returns {Response} 200 - Returns detailed information about the assistant
 * @throws {Error} Will throw an error if the assistant is not found or if there is an issue with the request
 */
export const getAssistantInfo = async (req, res) => {
  try {
    const { assistant_id } = req.params;

    const openai = await getOpenAIInstance();

    const myAssistant = await openai.beta.assistants.retrieve(assistant_id);
    res.status(200).send(myAssistant);
  } catch (err) {
    res.status(500).json({ error: err });
  }
};

/**
 * @async
 * @function updateFunctionCallingAssistantdata
 * @description Updates an existing function calling assistant with new data provided in request body
 * @param {Object} req - Request object. Should contain assistant attributes to be updated in the body and assistant_id in the params
 * @param {Object} res - Response object
 * @returns {Response} 200 - Returns message and updated assistant data
 * @throws {Error} Will throw an error if the assistant is not found, or if there are issues during the update process
 */
export const updateFunctionCallingAssistantdata = async (req, res) => {
  const { assistant_id } = req.params;
  const {
    name,
    instructions,
    userSelectedModel: model,
    tools,
    description,
  } = req.body;

  try {
    const existingAssistant = await Assistant.findOne({ assistant_id });

    if (!existingAssistant || existingAssistant.functionCalling === false) {
      throw new Error("Assistant not found");
    }

    const openai = await getOpenAIInstance();

    const myAssistant = await openai.beta.assistants.retrieve(assistant_id);

    let assistantTools;

    if (tools) {
      assistantTools = tools.map((tool) => {
        return {
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters || {}, // If parameters are not provided, default to an empty object
          },
        };
      });
    }

    // Only include properties in the updateData if they are present in the request body
    const updateData = {};
    if (name) updateData.name = name;
    if (instructions) updateData.instructions = instructions;
    if (description) updateData.description = description;
    if (model) updateData.model = model;
    if (tools) updateData.tools = assistantTools;

    const myUpdatedAssistant = await openai.beta.assistants.update(
      assistant_id,
      updateData
    );

    if (myUpdatedAssistant) {
      if (name) existingAssistant.name = myUpdatedAssistant.name;
      if (instructions)
        existingAssistant.instructions = myUpdatedAssistant.instructions;
      if (model) existingAssistant.model = myUpdatedAssistant.model;
      if (tools) existingAssistant.tools = assistantTools;
      if (description) existingAssistant.description = description;

      await existingAssistant.save();
    }

    res.status(StatusCodes.CREATED).json({
      message: "Updated Function calling assistant successfully",
      assistant: existingAssistant,
    });
  } catch (error) {
    console.log(error);
    res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json({ message: error.message });
  }
};

/**
 * @async
 * @function editPrompt
 * @description Edit a prompt in an OpenAI Assistant thread using the workaround method:
 * 1. Delete the previous prompt message
 * 2. Add the updated prompt as a new message
 * 3. Start a new run for that thread
 * @param {Object} req - Request object. Should contain: { message_id, new_prompt, thread_id } in body and assistant_id in params
 * @param {Object} res - Response object
 * @param {function} next - Next middleware function
 * @returns {Response} 200 - Returns the new response and updated message info
 * @throws {Error} Will throw an error if edit fails or assistant not found
 */
export const editPrompt = async (req, res, next) => {
  console.time("Edit Prompt Execution Time");

  const { _id: userId } = req.user;
  const { assistant_id } = req.params;
  const { message_id, new_prompt, thread_id } = req.body;

  // Validation
  const validationResult = editPromptSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (validationResult.error) {
    console.timeEnd("Edit Prompt Execution Time");
    return next(
      BadRequest("Invalid input. Please check message ID, prompt content, and thread ID.")
    );
  }

  try {
    console.time("OpenAI Setup");
    const openai = await getOpenAIInstance();
    console.timeEnd("OpenAI Setup");

    console.time("Fetch Assistant");
    const assistant = await getAssistantByAssistantId(assistant_id);
    console.timeEnd("Fetch Assistant");

    if (!assistant) {
      console.timeEnd("Edit Prompt Execution Time");
      return next(NotFound(AssistantMessages.ASSISTANT_NOT_FOUND));
    }

    // Verify that the thread belongs to the user
    const existingThread = await AssistantThread.findOne({
      assistant_id,
      user: userId,
      thread_id,
    });

    if (!existingThread) {
      console.timeEnd("Edit Prompt Execution Time");
      return next(NotFound("Thread not found or unauthorized access."));
    }

    let runId;
    let run;

    try {
      console.time("Fetch Messages for Edit");
      const threadMessagesResponse = await openai.beta.threads.messages.list(thread_id);
      const messages = threadMessagesResponse.data;
      console.timeEnd("Fetch Messages for Edit");
      // Step 1: Delete the previous message
      console.time("Delete Message");
      // Step 1: Find the edited message
      const editedMsg = messages.find((m) => m.id === message_id);
      if (!editedMsg) throw new Error("Edited message not found");

      // Step 2: Find the assistant reply that follows it directly
      const sortedMessages = [...messages].sort((a, b) => a.created_at - b.created_at);

      const editedIndex = sortedMessages.findIndex((m) => m.id === message_id);

      // Step 3: Look ahead for the first assistant message
      let assistantReply = null;
      for (let i = editedIndex + 1; i < sortedMessages.length; i++) {
        if (sortedMessages[i].role === 'assistant') {
          assistantReply = sortedMessages[i];
          break;
        } else if (sortedMessages[i].role === 'user') {
          // Stop scanning if a new user message appears — reply must have been missing or already removed
          break;
        }
      }

      // Step 4: Delete only the edited user message and its reply (if found)
      await deleteMessageFromThread(openai, thread_id, message_id);

      if (assistantReply) {
        await deleteMessageFromThread(openai, thread_id, assistantReply.id);
      }

      console.timeEnd("Delete Message");

      // Step 2: Create new message with updated prompt
      console.time("Create New Message");
      await createMessageInThread(openai, thread_id, new_prompt);
      console.timeEnd("Create New Message");

      // Step 3: Start a new run
      console.time("Create New Run");
      run = await createRunForThread(openai, thread_id, assistant_id);
      runId = run?.id;
      console.timeEnd("Create New Run");

      if (!runId) throw new Error("Run creation failed");
    } catch (err) {
      console.error("Error during prompt edit process:", err);
      console.timeEnd("Edit Prompt Execution Time");
      return next(BadRequest("Failed to edit prompt. The original message may have been deleted, or there was an OpenAI API error."));
    }

    // Monitor the run status (similar to createChatPerAssistant)
    let retrieveRun;
    try {
      console.time("Retrieve Run Status");
      retrieveRun = await retrieveRunFromThread(openai, thread_id, runId);
      console.timeEnd("Retrieve Run Status");
    } catch (err) {
      console.error("Initial run status check failed:", err);
      console.timeEnd("Edit Prompt Execution Time");
      return next(BadRequest("Failed to check run status."));
    }

    let openAIErrorFlag = false;
    while (retrieveRun.status !== "completed") {
      console.log(`Run status: ${retrieveRun.status}`);

      if (["failed", "cancelled", "expired"].includes(retrieveRun.status)) {
        openAIErrorFlag = true;
        break;
      }

      if (retrieveRun.status === "requires_action") {
        try {
          const runWithToolCall = await retrieveRunFromThread(openai, thread_id, runId);
          const toolCalls = runWithToolCall.required_action.submit_tool_outputs.tool_calls;

          const toolOutputs = await onToolCalls(assistant_id, toolCalls, assistant.functionCalling);
          await submitToolOutputs(openai, thread_id, runId, toolOutputs);
        } catch (err) {
          console.error("Error handling tool calls:", err);
          openAIErrorFlag = true;
          break;
        }
      }

      await new Promise((res) => setTimeout(res, 1000));
      retrieveRun = await retrieveRunFromThread(openai, thread_id, runId);
    }

    if (openAIErrorFlag) {
      console.timeEnd("Edit Prompt Execution Time");
      return next(BadRequest("Assistant failed to complete the response after prompt edit."));
    }

    try {
      console.time("Fetch Updated Messages");
      const threadMessages = await messageListFromThread(openai, thread_id);
      console.timeEnd("Fetch Updated Messages");

      const finalMsg = threadMessages.data.find(
        (msg) => msg.run_id === runId && msg.role === "assistant"
      );

      if (finalMsg) {
        console.timeEnd("Edit Prompt Execution Time");
        return res.status(200).json({
          response: await processAssistantMessage(finalMsg),
          msg_id: finalMsg.id,
          thread_id: thread_id,
          edited_prompt: new_prompt,
        });
      }

      return res.status(500).json({ message: AssistantMessages.SOMETHING_WENT_WRONG });
    } catch (err) {
      console.error("Message retrieval error after edit:", err);
      console.timeEnd("Edit Prompt Execution Time");
      return next(BadRequest("OpenAI did not return a valid assistant message after editing."));
    }
  } catch (err) {
    console.error("Unexpected error during prompt edit:", err);
    console.timeEnd("Edit Prompt Execution Time");
    return next(err);
  }
};
