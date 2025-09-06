import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const NWS_API_BASE = "https://api.weather.gov";
const USER_AGENT = "weather-app/1.0";
// Create server instance
const server = new McpServer({
    name: "weather",
    version: "1.0.0",
    capabilities: {
        resources: {},
        tools: {
            get_alerts: {
                description: "Get weather alerts for a state",
                inputSchema: {
                    type: "object",
                    properties: {
                        state: { type: "string", minLength: 2, maxLength: 2 },
                    },
                    required: ["state"],
                },
            },
            get_forecast: {
                description: "Get weather forecast for a location",
                inputSchema: {
                    type: "object",
                    properties: {
                        latitude: { type: "number", minimum: -90, maximum: 90 },
                        longitude: { type: "number", minimum: -180, maximum: 180 },
                    },
                    required: ["latitude", "longitude"],
                },
            },
        },
    },
});
// Helper function for making NWS API requests
async function makeNWSRequest(url) {
    const headers = {
        "User-Agent": USER_AGENT,
        Accept: "application/geo+json",
    };
    try {
        const response = await fetch(url, { headers });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return (await response.json());
    }
    catch (error) {
        console.error("Error making NWS request:", error);
        return null;
    }
}
// Format alert data
function formatAlert(feature) {
    const props = feature.properties;
    return [
        `Event: ${props.event || "Unknown"}`,
        `Area: ${props.areaDesc || "Unknown"}`,
        `Severity: ${props.severity || "Unknown"}`,
        `Status: ${props.status || "Unknown"}`,
        `Headline: ${props.headline || "No headline"}`,
        "---",
    ].join("\n");
}
// Register weather tools for Node.js version
server.tool("get_alerts", "Get weather alerts for a state", {
    state: z.string().length(2).describe("Two-letter state code (e.g. CA, NY)"),
}, async ({ state }) => {
    const stateCode = state.toUpperCase();
    const alertsUrl = `${NWS_API_BASE}/alerts?area=${stateCode}`;
    const alertsData = await makeNWSRequest(alertsUrl);
    if (!alertsData) {
        return {
            content: [
                {
                    type: "text",
                    text: "Failed to retrieve alerts data",
                },
            ],
        };
    }
    const features = alertsData.features || [];
    if (features.length === 0) {
        return {
            content: [
                {
                    type: "text",
                    text: `No active alerts for ${stateCode}`,
                },
            ],
        };
    }
    const formattedAlerts = features.map(formatAlert);
    const alertsText = `Active alerts for ${stateCode}:\n\n${formattedAlerts.join("\n")}`;
    return {
        content: [
            {
                type: "text",
                text: alertsText,
            },
        ],
    };
});
server.tool("get_forecast", "Get weather forecast for a location", {
    latitude: z.number().min(-90).max(90).describe("Latitude of the location"),
    longitude: z
        .number()
        .min(-180)
        .max(180)
        .describe("Longitude of the location"),
}, async ({ latitude, longitude }) => {
    // Get grid point data
    const pointsUrl = `${NWS_API_BASE}/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`;
    const pointsData = await makeNWSRequest(pointsUrl);
    if (!pointsData) {
        return {
            content: [
                {
                    type: "text",
                    text: `Failed to retrieve grid point data for coordinates: ${latitude}, ${longitude}. This location may not be supported by the NWS API (only US locations are supported).`,
                },
            ],
        };
    }
    const forecastUrl = pointsData.properties?.forecast;
    if (!forecastUrl) {
        return {
            content: [
                {
                    type: "text",
                    text: "Failed to get forecast URL from grid point data",
                },
            ],
        };
    }
    // Get forecast data
    const forecastData = await makeNWSRequest(forecastUrl);
    if (!forecastData) {
        return {
            content: [
                {
                    type: "text",
                    text: "Failed to retrieve forecast data",
                },
            ],
        };
    }
    const periods = forecastData.properties?.periods || [];
    if (periods.length === 0) {
        return {
            content: [
                {
                    type: "text",
                    text: "No forecast periods available",
                },
            ],
        };
    }
    // Format forecast periods
    const formattedForecast = periods.map((period) => [
        `${period.name || "Unknown"}:`,
        `Temperature: ${period.temperature || "Unknown"}°${period.temperatureUnit || "F"}`,
        `Wind: ${period.windSpeed || "Unknown"} ${period.windDirection || ""}`,
        `${period.shortForecast || "No forecast available"}`,
        "---",
    ].join("\n"));
    const forecastText = `Forecast for ${latitude}, ${longitude}:\n\n${formattedForecast.join("\n")}`;
    return {
        content: [
            {
                type: "text",
                text: forecastText,
            },
        ],
    };
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Weather MCP Server running on stdio");
}
// Only run main() in Node.js environment
if (typeof process !== "undefined" &&
    process.versions &&
    process.versions.node) {
    main().catch((error) => {
        console.error("Fatal error in main():", error);
        process.exit(1);
    });
}
// Enhanced Cloudflare Worker fetch handler with better MCP JSON-RPC support
export default {
    async fetch(request) {
        // Handle CORS preflight requests
        if (request.method === "OPTIONS") {
            return new Response(null, {
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                },
            });
        }
        // Only handle POST requests for MCP
        if (request.method !== "POST") {
            return new Response(JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32601, message: "Method not found" },
                id: null,
            }), {
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                },
                status: 200, // JSON-RPC errors should return 200
            });
        }
        try {
            // Parse the JSON-RPC request
            const body = await request.json();
            const { method, params, id } = body;
            let result;
            switch (method) {
                case "initialize":
                    result = {
                        protocolVersion: "2024-11-05", // Use stable protocol version
                        capabilities: {
                            tools: {},
                            resources: {},
                            prompts: {},
                            logging: {},
                        },
                        serverInfo: {
                            name: "weather",
                            version: "1.0.0",
                        },
                    };
                    break;
                case "notifications/initialized":
                    // This is a notification, no response needed
                    return new Response(null, { status: 204 });
                case "ping":
                    result = {};
                    break;
                case "tools/list":
                    result = {
                        tools: [
                            {
                                name: "get_alerts",
                                description: "Get weather alerts for a state",
                                inputSchema: {
                                    type: "object",
                                    properties: {
                                        state: {
                                            type: "string",
                                            minLength: 2,
                                            maxLength: 2,
                                            description: "Two-letter state code (e.g. CA, NY)",
                                        },
                                    },
                                    required: ["state"],
                                },
                            },
                            {
                                name: "get_forecast",
                                description: "Get weather forecast for a location",
                                inputSchema: {
                                    type: "object",
                                    properties: {
                                        latitude: {
                                            type: "number",
                                            minimum: -90,
                                            maximum: 90,
                                            description: "Latitude of the location",
                                        },
                                        longitude: {
                                            type: "number",
                                            minimum: -180,
                                            maximum: 180,
                                            description: "Longitude of the location",
                                        },
                                    },
                                    required: ["latitude", "longitude"],
                                },
                            },
                        ],
                    };
                    break;
                case "resources/list":
                    result = {
                        resources: [],
                    };
                    break;
                case "prompts/list":
                    result = {
                        prompts: [],
                    };
                    break;
                case "tools/call":
                    if (!params || !params.name) {
                        return createErrorResponse(-32602, "Invalid params", id);
                    }
                    if (params.name === "get_alerts") {
                        const args = params.arguments || {};
                        if (!args.state) {
                            return createErrorResponse(-32602, "Missing required parameter: state", id);
                        }
                        const { state } = args;
                        const stateCode = state.toUpperCase();
                        const alertsUrl = `${NWS_API_BASE}/alerts?area=${stateCode}`;
                        const alertsData = await makeNWSRequest(alertsUrl);
                        if (!alertsData) {
                            result = {
                                content: [
                                    { type: "text", text: "Failed to retrieve alerts data" },
                                ],
                            };
                        }
                        else {
                            const features = alertsData.features || [];
                            if (features.length === 0) {
                                result = {
                                    content: [
                                        { type: "text", text: `No active alerts for ${stateCode}` },
                                    ],
                                };
                            }
                            else {
                                const formattedAlerts = features.map(formatAlert);
                                const alertsText = `Active alerts for ${stateCode}:\n\n${formattedAlerts.join("\n")}`;
                                result = {
                                    content: [{ type: "text", text: alertsText }],
                                };
                            }
                        }
                    }
                    else if (params.name === "get_forecast") {
                        const args = params.arguments || {};
                        if (args.latitude === undefined || args.longitude === undefined) {
                            return createErrorResponse(-32602, "Missing required parameters: latitude and/or longitude", id);
                        }
                        const { latitude, longitude } = args;
                        // Get grid point data
                        const pointsUrl = `${NWS_API_BASE}/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`;
                        const pointsData = await makeNWSRequest(pointsUrl);
                        if (!pointsData) {
                            result = {
                                content: [
                                    {
                                        type: "text",
                                        text: `Failed to retrieve grid point data for coordinates: ${latitude}, ${longitude}. This location may not be supported by the NWS API (only US locations are supported).`,
                                    },
                                ],
                            };
                        }
                        else {
                            const forecastUrl = pointsData.properties?.forecast;
                            if (!forecastUrl) {
                                result = {
                                    content: [
                                        {
                                            type: "text",
                                            text: "Failed to get forecast URL from grid point data",
                                        },
                                    ],
                                };
                            }
                            else {
                                // Get forecast data
                                const forecastData = await makeNWSRequest(forecastUrl);
                                if (!forecastData) {
                                    result = {
                                        content: [
                                            {
                                                type: "text",
                                                text: "Failed to retrieve forecast data",
                                            },
                                        ],
                                    };
                                }
                                else {
                                    const periods = forecastData.properties?.periods || [];
                                    if (periods.length === 0) {
                                        result = {
                                            content: [
                                                { type: "text", text: "No forecast periods available" },
                                            ],
                                        };
                                    }
                                    else {
                                        // Format forecast periods
                                        const formattedForecast = periods.map((period) => [
                                            `${period.name || "Unknown"}:`,
                                            `Temperature: ${period.temperature || "Unknown"}°${period.temperatureUnit || "F"}`,
                                            `Wind: ${period.windSpeed || "Unknown"} ${period.windDirection || ""}`,
                                            `${period.shortForecast || "No forecast available"}`,
                                            "---",
                                        ].join("\n"));
                                        const forecastText = `Forecast for ${latitude}, ${longitude}:\n\n${formattedForecast.join("\n")}`;
                                        result = {
                                            content: [{ type: "text", text: forecastText }],
                                        };
                                    }
                                }
                            }
                        }
                    }
                    else {
                        return createErrorResponse(-32601, `Unknown tool: ${params.name}`, id);
                    }
                    break;
                default:
                    return createErrorResponse(-32601, `Method not found: ${method}`, id);
            }
            // Return successful response
            return new Response(JSON.stringify({
                jsonrpc: "2.0",
                result,
                id,
            }), {
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                },
            });
        }
        catch (error) {
            console.error("MCP Server Error:", error);
            return createErrorResponse(-32603, "Internal error", null, error instanceof Error ? error.message : String(error));
        }
    },
};
// Helper function to create error responses
function createErrorResponse(code, message, id, data) {
    return new Response(JSON.stringify({
        jsonrpc: "2.0",
        error: {
            code,
            message,
            ...(data && { data }),
        },
        id,
    }), {
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        status: 200, // JSON-RPC errors should return HTTP 200
    });
}
