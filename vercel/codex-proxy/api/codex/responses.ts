import { handleCodexResponsesRequest } from "../../src/handler";

export const config = {
  runtime: "nodejs",
};

export default {
  async fetch(request: Request): Promise<Response> {
    return await handleCodexResponsesRequest(request);
  },
};
