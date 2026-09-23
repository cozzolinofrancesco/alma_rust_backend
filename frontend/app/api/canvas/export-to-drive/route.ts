import { google } from 'googleapis';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { NextRequest, NextResponse } from 'next/server';

interface ExportToDriveRequest {
    folderId: string;
    content: string;
    fileName: string;
    mimeType: string;
}

export async function POST(request: NextRequest) {
    try {
        const session = await getApiSession(request);
        if (!session?.accessToken) {
            return NextResponse.json({ error: 'User not authenticated' }, { status: 401 });
        }

        const { folderId, content, fileName, mimeType }: ExportToDriveRequest = await request.json();

        if (!folderId || !content || !fileName) {
            return NextResponse.json({ error: 'folderId, content, and fileName are required' }, { status: 400 });
        }

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

        const fileResponse = await drive.files.create({
            requestBody: {
                name: fileName,
                parents: [folderId],
            },
            media: {
                mimeType: mimeType || 'text/plain',
                body: content,
            },
            fields: 'id, name, webViewLink',
        });

        return NextResponse.json({
            success: true,
            fileId: fileResponse.data.id,
            fileName: fileResponse.data.name,
            webViewLink: fileResponse.data.webViewLink,
        });
    } catch (error) {
        console.error('Error exporting to Drive:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            { status: 500 }
        );
    }
}
