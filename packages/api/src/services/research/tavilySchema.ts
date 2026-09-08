/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Public provider parameter metadata observed through AgentKey on 2026-09-08.
export const tavilySchema = {
  "properties": {
    "auto_parameters": {
      "default": false,
      "description": "Automatically configure search parameters based on the query. Uses 2 API credits per request.",
      "type": "boolean"
    },
    "chunks_per_source": {
      "default": 3,
      "description": "Maximum number of relevant chunks (max 500 chars each) returned per source, controlling `content` length. Available only when `search_depth` is `advanced`.",
      "maximum": 3,
      "minimum": 1,
      "type": "integer"
    },
    "country": {
      "description": "Boost search results from a specific country. Available only if topic is `general`.",
      "type": "string"
    },
    "end_date": {
      "description": "Return all results before the specified end date (YYYY-MM-DD).",
      "type": "string"
    },
    "exact_match": {
      "default": false,
      "description": "Only return results containing exact quoted phrase(s) in the query.",
      "type": "boolean"
    },
    "exclude_domains": {
      "default": [],
      "description": "A list of domains to exclude (max 150).",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "include_answer": {
      "default": false,
      "description": "Include an LLM-generated answer. `basic`/`true` returns a quick answer; `advanced` returns a more detailed answer."
    },
    "include_domains": {
      "default": [],
      "description": "A list of domains to include (max 300).",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "include_favicon": {
      "default": false,
      "description": "Whether to include the favicon URL for each result.",
      "type": "boolean"
    },
    "include_image_descriptions": {
      "default": false,
      "description": "When `include_images` is `true`, also add descriptive text for each image.",
      "type": "boolean"
    },
    "include_images": {
      "default": false,
      "description": "Include images in the response.",
      "type": "boolean"
    },
    "include_raw_content": {
      "default": false,
      "description": "Include the cleaned and parsed HTML content of each result. `markdown`/`true` returns markdown; `text` returns plain text."
    },
    "include_usage": {
      "default": false,
      "description": "Whether to include credit usage information in the response.",
      "type": "boolean"
    },
    "max_results": {
      "default": 5,
      "description": "The maximum number of search results to return.",
      "maximum": 20,
      "minimum": 0,
      "type": "integer"
    },
    "query": {
      "description": "The search query to execute with Tavily.",
      "type": "string"
    },
    "safe_search": {
      "default": false,
      "description": "Enterprise only. Filter out adult or unsafe content. Not supported for `fast` or `ultra-fast` search depths.",
      "type": "boolean"
    },
    "search_depth": {
      "default": "basic",
      "description": "Controls the latency vs. relevance tradeoff and how `results[].content` is generated. Cost: `basic`, `fast`, `ultra-fast` use 1 API credit; `advanced` uses 2 API credits.",
      "enum": [
        "advanced",
        "basic",
        "fast",
        "ultra-fast"
      ],
      "type": "string"
    },
    "start_date": {
      "description": "Return all results after the specified start date (YYYY-MM-DD).",
      "type": "string"
    },
    "time_range": {
      "description": "The time range back from the current date to filter results based on publish/updated date.",
      "enum": [
        "day",
        "week",
        "month",
        "year",
        "d",
        "w",
        "m",
        "y"
      ],
      "type": "string"
    },
    "topic": {
      "default": "general",
      "description": "The category of the search. `news` retrieves real-time updates; `general` is for broader searches; `finance` for financial topics.",
      "enum": [
        "general",
        "news",
        "finance"
      ],
      "type": "string"
    }
  },
  "required": [
    "query"
  ],
  "type": "object"
} as const;
