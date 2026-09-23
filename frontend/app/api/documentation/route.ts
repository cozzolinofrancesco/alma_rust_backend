import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const filePath = url.searchParams.get('file');
    
    if (!filePath) {
      return NextResponse.json({ error: 'File path is required' }, { status: 400 });
    }

    let normalizedPath = path.normalize(filePath);
    
    if (normalizedPath.startsWith('/')) {
      normalizedPath = normalizedPath.substring(1);
    }
    
    if (normalizedPath.includes('..')) {
      return NextResponse.json({ error: 'Invalid file path' }, { status: 400 });
    }

    const fullPath = path.join(process.cwd(), 'app/documentation', normalizedPath);
    
    try {
      const content = await readFile(fullPath, 'utf-8');
      
      return new NextResponse(content, {
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    } catch (fileError) {
      console.error('Error reading documentation file:', fileError);
      return NextResponse.json(
        { error: 'File not found or could not be read' }, 
        { status: 404 }
      );
    }
  } catch (error) {
    console.error('Error in documentation API:', error);
    return NextResponse.json(
      { error: 'Internal server error' }, 
      { status: 500 }
    );
  }
} 