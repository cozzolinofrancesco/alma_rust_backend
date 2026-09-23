import { google } from 'googleapis';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { NextRequest, NextResponse } from 'next/server';

interface SaveCanvasProjectRequest {
    title: string;
    content: string;
    projectId?: string;
    fileName?: string;
}

export async function POST(request: NextRequest) {
    try {
        const session = await getApiSession(request);
        if (!session?.accessToken) {
            return NextResponse.json({ error: 'User not authenticated' }, { status: 401 });
        }

        const { title, content, projectId, fileName }: SaveCanvasProjectRequest = await request.json();

        if (!title || !content) {
            return NextResponse.json({ error: 'Title and content are required' }, { status: 400 });
        }

        if (!projectId) {
            return NextResponse.json({ error: 'Project ID is required' }, { status: 400 });
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

        const folderName = 'LatexFullDocs';
        let folderId: string;

        const folderSearch = await drive.files.list({
            q: `name='${folderName}' and parents='${projectId}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id, name)',
        });

        if (folderSearch.data.files && folderSearch.data.files.length > 0) {
            folderId = folderSearch.data.files[0].id!;
        } else {
            const folderResponse = await drive.files.create({
                requestBody: {
                    name: folderName,
                    mimeType: 'application/vnd.google-apps.folder',
                    parents: [projectId],
                },
                fields: 'id',
            });
            folderId = folderResponse.data.id!;
        }

        const finalFileName = fileName || `${title.replace(/[^a-zA-Z0-9-_]/g, '_')}_${new Date().toISOString().split('T')[0]}.md`;

        const fileNameWithExtension = finalFileName.endsWith('.md') ? finalFileName : `${finalFileName}.md`;

        const fileSearch = await drive.files.list({
            q: `name='${fileNameWithExtension}' and parents='${folderId}' and trashed=false`,
            fields: 'files(id, name)',
        });

        let fileId: string;
        if (fileSearch.data.files && fileSearch.data.files.length > 0) {
            fileId = fileSearch.data.files[0].id!;
            await drive.files.update({
                fileId: fileId,
                media: {
                    mimeType: 'text/markdown',
                    body: content,
                },
                fields: 'id, name, modifiedTime',
            });
        } else {
            const fileResponse = await drive.files.create({
                requestBody: {
                    name: fileNameWithExtension,
                    parents: [folderId],
                },
                media: {
                    mimeType: 'text/markdown',
                    body: content,
                },
                fields: 'id, name, createdTime',
            });
            fileId = fileResponse.data.id!;
        }

        return NextResponse.json({
            success: true,
            fileId: fileId,
            fileName: fileNameWithExtension,
            folderName: folderName,
            message: 'Canvas project saved successfully',
        });

    } catch (error) {
        console.error('Error saving canvas project:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
} 