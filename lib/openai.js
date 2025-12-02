import { getOpenAIInstance } from "../config/openAI.js";


export const retrieveAssistantFromOpenAI = async (openai, assistantId) => {
    try {
      const assistant = await openai.beta.assistants.retrieve(assistantId);
      const assistantInfo = {
        ...assistant,
        file_ids: assistant?.tool_resources?.code_interpreter?.file_ids || []
      }
      return assistant;
    } catch (error) {
      return error
    }
  };
  
  export const messageListFromThread = (openai, threadId) => {
    return openai.beta.threads.messages.list(threadId)
  };

  export const retrieveRunFromThread = (openai, threadId, runId) => {

    return openai.beta.threads.runs.retrieve(threadId, runId);
  };

  export const submitToolOutputs = (openai, threadId, runId, toolOutputs) => {
    return openai.beta.threads.runs.submitToolOutputs(
      threadId,
      runId,
      {
        tool_outputs: toolOutputs,
      }
    )
  }

  // Function to delete a message from a thread
  export const deleteMessageFromThread = (openai, threadId, messageId) => {
    return openai.beta.threads.messages.del(threadId, messageId);
  };

  // Function to create a new message in a thread
  export const createMessageInThread = (openai, threadId, content, role = "user") => {
    return openai.beta.threads.messages.create(threadId, {
      role,
      content,
    });
  };

  // Function to create a new run for a thread
  export const createRunForThread = (openai, threadId, assistantId) => {
    return openai.beta.threads.runs.create(threadId, {
      assistant_id: assistantId,
    });
  };