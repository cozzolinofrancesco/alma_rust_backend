import { google } from 'googleapis';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { NextRequest, NextResponse } from 'next/server';

function escapeHtml(input: string): string {
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

interface CreateDocRequest {
    title: string;
    content: string;
    format?: 'html' | 'text';
}

export async function POST(request: NextRequest) {
    try {
        const session = await getApiSession(request);
        if (!session?.accessToken) {
            return NextResponse.json({ error: 'User not authenticated' }, { status: 401 });
        }

        const { title, content, format }: CreateDocRequest = await request.json();

        if (!title || !content) {
            return NextResponse.json({ error: 'Title and content are required' }, { status: 400 });
        }

        const uploadFormat: 'html' | 'text' = format === 'text' ? 'text' : 'html';

        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID!,
            process.env.GOOGLE_CLIENT_SECRET!,
            process.env.GOOGLE_REDIRECT_URI!
        );
        oauth2Client.setCredentials({
            access_token: session.accessToken,
            refresh_token: session.refreshToken,
        });

        const drive = google.drive({ version: 'v3', auth: oauth2Client });

        const createResponse = await drive.files.create({
            requestBody: {
                name: title,
                mimeType: 'application/vnd.google-apps.document',
            },
            fields: 'id, name, mimeType',
        });

        const documentId = createResponse.data.id!;

        const htmlBody =
            uploadFormat === 'html'
                ? `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${content}</body></html>`
                : content;

        await drive.files.update({
            fileId: documentId,
            media: {
                mimeType: uploadFormat === 'html' ? 'text/html' : 'text/plain',
                body: htmlBody,
            },
        });

        const fileInfo = await drive.files.get({
            fileId: documentId,
            fields: 'webViewLink, id, name',
        });

        return NextResponse.json({
            document: {
                id: documentId,
                webViewLink: fileInfo.data.webViewLink,
                name: fileInfo.data.name,
            },
        });

    } catch (error) {
        console.error('Error creating Google Doc via Drive API:', error);
        
        if (error instanceof Error) {
            if (error.message.includes('insufficient authentication') || error.message.includes('unauthorized')) {
                return NextResponse.json({ 
                    error: 'Authentication Error',
                    details: 'Unable to authenticate with Google Drive API.',
                    action: 'Please try logging out and logging back in.',
                    fallback: 'You can use the Download option instead.'
                }, { status: 401 });
            }
            
            if (error.message.includes('quotaExceeded')) {
                return NextResponse.json({ 
                    error: 'API Quota Exceeded',
                    details: 'Google Drive API quota has been exceeded.',
                    action: 'Please try again later.',
                    fallback: 'You can use the Download option instead.'
                }, { status: 429 });
            }
        }
        
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json({ 
            error: 'Document Creation Failed',
            details: errorMessage,
            fallback: 'You can use the Download option instead.'
        }, { status: 500 });
    }
} 