import Joi from "joi";

export const createChatPerAssistantSchema = Joi.object({
    question: Joi.string().max(32700).required(),    
  }).unknown();

export const editPromptSchema = Joi.object({
    message_id: Joi.string().required(),
    new_prompt: Joi.string().max(32700).required(),
    thread_id: Joi.string().required(),
  }).unknown();