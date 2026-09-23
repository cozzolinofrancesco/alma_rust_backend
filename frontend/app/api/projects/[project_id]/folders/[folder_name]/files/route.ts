if (typeof window === 'undefined' && typeof global.File === 'undefined') {
  const { File } = await import('fetch-blob/file.js');
  global.File = File;
}

import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { Readable } from 'stream';
import type { ReadableStream as NodeReadableStream } from 'stream/web';

export const runtime = 'nodejs';

interface NodeCompatibleReadableStream<T> extends NodeReadableStream<T> {
  values: () => AsyncGenerator<T, undefined, unknown>;
  [Symbol.asyncIterator]: () => AsyncGenerator<T, undefined, unknown>;
}

function createNodeReadableStreamFromBlobStream(
  blobStream: ReadableStream<Uint8Array>
): NodeCompatibleReadableStream<Uint8Array> {
  async function* asyncIterator(): AsyncGenerator<Uint8Array, undefined, unknown> {
    const reader = blobStream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
    return undefined;
  }

  const newStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const chunk of asyncIterator()) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  }) as NodeCompatibleReadableStream<Uint8Array>;

  newStream.values = asyncIterator;
  newStream[Symbol.asyncIterator] = asyncIterator;

  return newStream;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ project_id: string; folder_name: string }> }
): Promise<Response> {
  try {

    const { project_id, folder_name } = await params;

    const session = await getApiSession(request);
    if (!session || !session.accessToken) {
      return NextResponse.json({ error: 'User not authenticated' }, { status: 401 });
    }
    const { accessToken, refreshToken } = session;

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID!,
      process.env.GOOGLE_CLIENT_SECRET!,
      process.env.GOOGLE_REDIRECT_URI!
    );
    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const folderList = await drive.files.list({
      q: `'${project_id}' in parents and name='${folder_name}' and mimeType='application/vnd.google-apps.folder'`,
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    let folderId: string;
    if (folderList.data.files?.length) {
      folderId = folderList.data.files[0].id!;
    } else if (folder_name === 'Extracts') {
      const createRes = await drive.files.create({
        requestBody: {
          name: 'Extracts',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [project_id],
        },
        fields: 'id',
        supportsAllDrives: true,
      });
      if (!createRes.data.id) {
        return NextResponse.json(
          { error: 'Failed to create Extracts folder' },
          { status: 500 }
        );
      }
      folderId = createRes.data.id;
    } else {
      return NextResponse.json(
        { error: `Folder '${folder_name}' not found in project '${project_id}'` },
        { status: 404 }
      );
    }

    const filesList = await drive.files.list({
      q: `'${folderId}' in parents`,
      fields: 'files(id, name, mimeType, createdTime, modifiedTime)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    return NextResponse.json({
      project_id,
      folder_id: folderId,
      folder_name: folder_name,
      files: filesList.data.files || [],
    });
  } catch (error: unknown) {
    console.error('Error listing files:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ project_id: string; folder_name: string }> }
): Promise<Response> {
  try {

    const { project_id, folder_name } = await params;

    const session = await getApiSession(request);
    if (!session?.accessToken) {
      return NextResponse.json({ error: 'User not authenticated' }, { status: 401 });
    }
    const { accessToken, refreshToken } = session;

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID!,
      process.env.GOOGLE_CLIENT_SECRET!,
      process.env.GOOGLE_REDIRECT_URI!
    );
    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const formData = await request.formData();
    const fileField = formData.get('file');
    if (!(fileField instanceof Blob)) {
      return NextResponse.json({ error: 'No file provided or file is not a valid Blob' }, { status: 400 });
    }

    const folderList = await drive.files.list({
      q: `'${project_id}' in parents and name='${folder_name}' and mimeType='application/vnd.google-apps.folder'`,
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    let folderId: string;
    if (folderList.data.files?.length) {
      folderId = folderList.data.files[0].id!;
    } else {
      const folderMetadata = {
        name: folder_name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [project_id],
      };
      const folderRes = await drive.files.create({
        requestBody: folderMetadata,
        fields: 'id',
        supportsAllDrives: true,
      });
      if (!folderRes.data.id) {
        throw new Error('Failed to create folder');
      }
      folderId = folderRes.data.id;
    }

    const domStream = fileField.stream() as ReadableStream<Uint8Array>;
    const nodeCompatibleStream = createNodeReadableStreamFromBlobStream(domStream);
    const fileStream = Readable.fromWeb(nodeCompatibleStream);

    const fileName = fileField instanceof File && fileField.name ? fileField.name : 'uploaded_file';
    const fileMetadata = {
      name: fileName,
      parents: [folderId],
    };

    const uploadRes = await drive.files.create({
      requestBody: fileMetadata,
      media: {
        mimeType: fileField.type || 'application/octet-stream',
        body: fileStream,
      },
      fields: 'id',
      supportsAllDrives: true,
    });

    return NextResponse.json({
      file_id: uploadRes.data.id,
      folder_name: folder_name,
    });
  } catch (error: unknown) {
    console.error('Error uploading file:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
