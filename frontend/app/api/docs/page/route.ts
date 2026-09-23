import { NextResponse } from 'next/server';

export async function GET() {
  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ALMA API Documentation</title>
    <style>
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            line-height: 1.6;
            color: #333;
            background: #f8f9fa;
        }
        .header {
            background: #11074A;
            color: white;
            padding: 2rem;
            border-radius: 8px;
            margin-bottom: 2rem;
        }
        .endpoint {
            background: white;
            border: 1px solid #e1e5e9;
            border-radius: 8px;
            margin-bottom: 2rem;
            overflow: hidden;
        }
        .endpoint-header {
            background: #f1f3f4;
            padding: 1rem 1.5rem;
            border-bottom: 1px solid #e1e5e9;
        }
        .endpoint-body {
            padding: 1.5rem;
        }
        .method {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 0.8rem;
            font-weight: bold;
            color: white;
            background: #28a745;
        }
        .category {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 16px;
            font-size: 0.8rem;
            background: #e3f2fd;
            color: #1976d2;
            margin-left: 0.5rem;
        }
        .path {
            font-family: 'Monaco', 'Consolas', monospace;
            background: #f8f9fa;
            padding: 2px 6px;
            border-radius: 4px;
            margin-left: 0.5rem;
        }
        .params {
            margin: 1rem 0;
        }
        .param {
            background: #f8f9fa;
            border: 1px solid #e1e5e9;
            border-radius: 4px;
            padding: 0.75rem;
            margin: 0.5rem 0;
        }
        .param-name {
            font-weight: bold;
            color: #1976d2;
        }
        .param-type {
            background: #e8f5e8;
            color: #2e7d32;
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 0.8rem;
            margin-left: 0.5rem;
        }
        .required {
            background: #ffebee;
            color: #c62828;
        }
        .code-block {
            background: #282c34;
            color: #abb2bf;
            padding: 1rem;
            border-radius: 4px;
            overflow-x: auto;
            margin: 1rem 0;
        }
        .features {
            margin: 1rem 0;
        }
        .feature {
            background: #e8f5e8;
            border-left: 4px solid #4caf50;
            padding: 0.5rem 1rem;
            margin: 0.5rem 0;
        }
        .auth-section {
            background: #fff3cd;
            border: 1px solid #ffeaa7;
            border-radius: 4px;
            padding: 1rem;
            margin: 2rem 0;
        }
        h1, h2, h3 { margin-top: 0; }
        h1 { color: white; }
        h2 { color: #11074A; border-bottom: 2px solid #11074A; padding-bottom: 0.5rem; }
        a { color: #1976d2; text-decoration: none; }
        a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🔬 ALMA API Documentation</h1>
        <p>Complete API reference for all available endpoints</p>
        <p><strong>Base URL:</strong> <code id="base-url">Loading...</code></p>
    </div>

    <div class="auth-section">
        <h3>🔐 Authentication</h3>
        <p><strong>Type:</strong> API Key</p>
        <p><strong>Usage:</strong> Include your API key in the <code>api_key</code> parameter for all requests</p>
        <p><strong>Example:</strong> <code>api_key=YOUR_SERVICE_API_KEY</code></p>
    </div>

    <div id="endpoints-container">
        <p>Loading API documentation...</p>
    </div>

    <script>
        async function loadDocumentation() {
            try {
                const response = await fetch('/api/docs');
                const data = await response.json();
                
                document.getElementById('base-url').textContent = data.base_url;
                
                const container = document.getElementById('endpoints-container');
                container.innerHTML = '';
                
                Object.entries(data.endpoints).forEach(([key, endpoint]) => {
                    const endpointDiv = document.createElement('div');
                    endpointDiv.className = 'endpoint';
                    
                    endpointDiv.innerHTML = \`
                        <div class="endpoint-header">
                            <h2>\${endpoint.name}</h2>
                            <div>
                                <span class="method">\${endpoint.method}</span>
                                <span class="category">\${endpoint.category}</span>
                                <span class="path">\${endpoint.path}</span>
                            </div>
                        </div>
                        <div class="endpoint-body">
                            <p>\${endpoint.description}</p>
                            
                            <h3>📋 Parameters</h3>
                            <div class="params">
                                \${Object.entries(endpoint.parameters).map(([paramName, param]) => \`
                                    <div class="param">
                                        <span class="param-name">\${paramName}</span>
                                        <span class="param-type \${param.required ? 'required' : ''}">\${param.type}</span>
                                        \${param.required ? '<span style="color: #c62828; margin-left: 0.5rem;">*required</span>' : ''}
                                        <div style="margin-top: 0.5rem; color: #666;">\${param.description}</div>
                                    </div>
                                \`).join('')}
                            </div>
                            
                            \${endpoint.example ? \`
                                <h3>💻 Example</h3>
                                <p>\${endpoint.example.description}</p>
                                <div class="code-block">\${endpoint.example.curl}</div>
                                \${endpoint.example.response ? \`
                                    <h4>Response:</h4>
                                    <div class="code-block">\${JSON.stringify(endpoint.example.response, null, 2)}</div>
                                \` : ''}
                            \` : ''}
                            
                            \${endpoint.features ? \`
                                <h3>✨ Features</h3>
                                <div class="features">
                                    \${endpoint.features.map(feature => \`<div class="feature">\${feature}</div>\`).join('')}
                                </div>
                            \` : ''}
                        </div>
                    \`;
                    
                    container.appendChild(endpointDiv);
                });
                
            } catch (error) {
                console.error('Error loading documentation:', error);
                document.getElementById('endpoints-container').innerHTML = 
                    '<p style="color: red;">Error loading API documentation. Please try again later.</p>';
            }
        }
        
        loadDocumentation();
    </script>
</body>
</html>`;

  return new NextResponse(htmlContent, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
} 