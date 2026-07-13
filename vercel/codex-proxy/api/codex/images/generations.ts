import { handleCodexImagesRequest } from "../../../src/handler.js";

export const config = {
  runtime: "nodejs",
};

export default {
  async fetch(request: Request): Promise<Response> {
    return await handleCodexImagesRequest(request, "generations");
  },
};
