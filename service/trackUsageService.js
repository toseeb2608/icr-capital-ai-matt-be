import { getGeminiAIInstance } from "../config/geminiAi.js";
import { tokenPrices } from "../constants/tokenPrices.js";
import tiktoken from 'tiktoken-node';
import { generatePrevChatHistoryContext } from "./geminiAiPromptService.js";

export const calculateTokenAndCost = async (input_token, output_token, model_used, botProvider) => {
    // console.log({ input_token, output_token, model_used });

    const { input: inputTokenPrice, output: outputTokenPrice } = tokenPrices[model_used] || { input: 0.01, output: 0.01 };

    const flattenOutputToken = flattenOutputTokenStructure(output_token);

    let inputTokens = 0;
    let outputTokens = 0;

    if (botProvider == "openai") {
      inputTokens = tiktoken.encodingForModel(model_used).encode(input_token);
      outputTokens = tiktoken
        .encodingForModel(model_used)
        .encode(flattenOutputToken);
    }
    else if(botProvider == "gemini"){
        const geminiAi = await getGeminiAIInstance();
        const model = geminiAi.getGenerativeModel({ model: model_used });
        inputTokens = await model.countTokens(input_token);
        outputTokens = await model.countTokens(output_token);
    }

    let totalInputToken;
    let totalOutputToken;
    let totalCost = 0;
    if(botProvider == 'openai'){
        totalInputToken = inputTokens.length;
        totalOutputToken = outputTokens.length;
        totalCost = (totalInputToken * inputTokenPrice + totalOutputToken * outputTokenPrice) / 1000;
    } else if(botProvider == 'gemini'){
        totalInputToken = inputTokens.totalTokens;
        totalOutputToken = outputTokens.totalTokens;
        totalCost = (totalInputToken * inputTokenPrice) + (totalOutputToken * outputTokenPrice);
    }

    const totalTokens = totalInputToken + totalOutputToken;

    return {
        inputTokenPrice,
        outputTokenPrice,
        inputTokenCount: totalInputToken,
        outputTokenCount: totalOutputToken,
        totalCost,
        totalTokens,
    };
};

const flattenOutputTokenStructure = (output_token) => {
    if (Array.isArray(output_token)) {
        return output_token.map(flattenOutputTokenStructure).join('');
    } else if (typeof output_token === 'object' && output_token !== null) {
        return Object.values(output_token).map(flattenOutputTokenStructure).join('');
    } else {
        return output_token.toString();
    }
};
