import { getOpenAIInstance } from "../config/openAI.js";
import { retrieveAssistantFromOpenAI } from "../lib/openai.js";
import { assistantFuncMap } from "./assistantFunctionMapper.js";
import mongoose from "mongoose"


export const onToolCalls = async ( assistant_id, toolCalls,isDynamicFunctionCalling = false, userId ) => {
    const toolOutputs = [];
  const requiredActions = toolCalls;
  for (const action of requiredActions) {

    const funcName = action.function.name;
    console.log("🚀 ~ .on ~ funcName:", funcName);

    const argument = JSON.parse(action.function.arguments);
    // console.log(argument, "arg");


    let currOutput = {
      tool_call_id: action.id,
      output: "This function doesn't exist.",
    };


    const openai = await getOpenAIInstance();
    const myAssistant = await retrieveAssistantFromOpenAI(openai, assistant_id);

    const propertiesKeysObject =
      myAssistant?.tools[0]?.function?.parameters?.properties || {};
    const propertiesKeys = Object.keys(propertiesKeysObject);

    // all conditions
    const isCustomFunctionCallingAssistant =
      isDynamicFunctionCalling === true && propertiesKeys;
    const isLocalFunctionCallingAssistant =
      isDynamicFunctionCalling === false &&
      assistantFuncMap.hasOwnProperty(funcName);

    //check if function is from integerated service
    const functionNameArray = funcName.split("_");
    const endpoint_id = functionNameArray[functionNameArray.length - 1];
    try {
      const isValidObjectId = mongoose.Types.ObjectId.isValid(endpoint_id);
      const api = isValidObjectId
        ? await ServiceApi.findOne({ _id : endpoint_id })
        : null;
        if(api){
        const service_id = api.service_id;
        const service = await ServiceList.find({ _id : service_id });

        if (service) {
          const slug = service[0].slug;
        
          const creds = await ServiceCredentials.findOne({
            userId: userId,
            service_id: service_id,
          });
        
        
          const credentials = creds.credentials;
        
          if (!credentials) {
            throw new Error(`Credentials not found for service: ${slug}`);
          }
        
          try {
            const result = await Executer(
              slug,
              api.api_endpoint,
              api.method,
              creds.credentials,
              argument,
              creds.service_id,
              creds._id,
              creds.userId
            );
        
            currOutput.output = JSON.stringify(result);
          } catch (error) {
            console.error("Error during API execution:", error.message);
            currOutput.output = "This function doesn't exist.";
          }
        }        
        
      }else{
        // Else we handle local function calling if no API found
        if (isCustomFunctionCallingAssistant) {
          const argumentsList = propertiesKeys.map((key) => argument[key]);
          
          const functionName = funcName;

          const functionMap = await createFunctionMap({userId: argument.userDetails._id});
          // Create the function call dynamically using the spread operator
          if (typeof functionMap[functionName] === "function") {
            const output = await functionMap[functionName](...argumentsList);
            currOutput.output = JSON.stringify(output);
          }
        } else if (isLocalFunctionCallingAssistant) {
          const output = await assistantFuncMap[funcName](argument);
          currOutput.output = JSON.stringify(output);
        }
      }
    } catch (error) {
      console.error("Error during tool call execution:", error.message);
      currOutput.output = "An error occurred while processing the function.";
    }

    toolOutputs.push(currOutput);
  }

  return toolOutputs;
};