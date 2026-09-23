import { NextResponse } from 'next/server';

export async function GET() {
  const apiDocumentation = {
    title: "ALMA API Documentation",
    description: "Complete API reference for all available endpoints",
    version: "1.0.0",
    base_url: process.env.NEXTAUTH_URL || "http://localhost:3000",
    
    endpoints: {
      "image-analysis": {
        name: "Image Analysis", 
        path: "/api/image-analysis",
        method: "POST",
        description: "Analyze images using AI to extract insights, descriptions, and detailed content analysis",
        category: "AI Analysis",
        content_type: "multipart/form-data",
        parameters: {
          api_key: { type: "string", required: true, description: "API key for authentication" },
          image: { type: "file", required: true, description: "Image file (JPG, PNG, WebP, GIF)" },
          prompt: { type: "string", required: false, description: "Custom analysis prompt" }
        }
      },
      
      "ai-chat": {
        name: "AI Chat", 
        path: "/api/ai",
        method: "POST", 
        description: "Connect to AI model with 65k token input limit",
        category: "AI Analysis",
        content_type: "application/json",
        parameters: {
          messages: { type: "array", required: true, description: "Array of message objects with role and content" },
          model: { type: "string", required: false, description: "Optional model name" }
        }
      }
    },
    
    authentication: {
      type: "API Key",
      description: "Include your API key in the 'api_key' parameter for all requests",
      example: "api_key=YOUR_SERVICE_API_KEY"
    },
    
    response_format: {
      success: { status: "success", data: "..." },
      error: { status: "error", error: "Error type", message: "Error description" }
    }
  };

  return NextResponse.json(apiDocumentation, {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
} 