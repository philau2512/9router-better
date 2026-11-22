import { PROVIDER_MEDIA } from "../../providers/index.js";

const imageCfg = (id) => PROVIDER_MEDIA[id]?.imageConfig || {};
const imageUrl = (id) => imageCfg(id).baseUrl;

const ENDPOINTS = {
  openai: "https://api.openai.com/v1/images/generations",
  minimax: "https://api.minimaxi.com/v1/images/generations",
  openrouter: "https://openrouter.ai/api/v1/images/generations",
  recraft: "https://external.api.recraft.ai/v1/images/generations",
  xai: "https://api.x.ai/v1/images/generations",
};

export default function createOpenAIAdapter(providerId) {
  const cfg = imageCfg(providerId);
  return {
    buildUrl: () => imageUrl(providerId) || ENDPOINTS[providerId],
    buildHeaders: (creds) => {
      const headers = { "Content-Type": "application/json", ...(cfg.headers || {}) };
      const key = creds?.apiKey || creds?.accessToken;
      if (key) headers["Authorization"] = `Bearer ${key}`;
      if (providerId === "openrouter") {
        headers["HTTP-Referer"] = "https://endpoint-proxy.local";
        headers["X-Title"] = "Endpoint Proxy";
      }
      return headers;
    },
    buildBody: (model, body) => {
      const {
        prompt,
        n = 1,
        size = "1024x1024",
        quality,
        style,
        response_format,
        background,
        image_detail,
        output_format,
      } = body;
      // xAI: forward known image options; skip empty/"auto" where provider rejects them
      if (providerId === "xai") {
        const req = { model, prompt, n };
        if (size && size !== "auto") req.size = size;
        if (quality && quality !== "auto") req.quality = quality;
        if (background && background !== "auto") req.background = background;
        if (response_format) req.response_format = response_format;
        if (image_detail) req.image_detail = image_detail;
        if (output_format) req.output_format = output_format;
        return req;
      }
      const full = { model, prompt, n, size, output_format };
      if (quality) full.quality = quality;
      if (style) full.style = style;
      if (response_format) full.response_format = response_format;
      for (const field of ["output_format", "watermark", "prompt_extend"]) {
        if (cfg.bodyFields?.includes(field) && body[field] !== undefined) {
          full[field] = body[field];
        }
      }
      // bodyFields whitelist (e.g. xAI accepts only model/prompt/n/response_format)
      if (Array.isArray(cfg.bodyFields)) {
        const req = {};
        for (const f of cfg.bodyFields) if (full[f] !== undefined) req[f] = full[f];
        return req;
      }
      return full;
    },
    normalize: (responseBody) => responseBody,
  };
}
