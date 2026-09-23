import { google, type drive_v3 } from "googleapis";
import { getApiSession } from '@/app/lib/apiCaller.server';
import { NextResponse } from "next/server";

interface Params {
  folder_id: string;
}

interface FileInfo {
  id: string;
  name: string;
  type: "Folder" | "File";
  createdTime?: string;
  modifiedTime?: string;
  size?: number;
}

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<Params> }
): Promise<NextResponse> {
  try {
    const { folder_id } = await params;

    const foldersOnly =
      new URL(request.url).searchParams.get("type") === "folders";

    const session = await getApiSession(request);
    if (!session?.accessToken) {
      return NextResponse.json(
        { error: "User not authenticated" },
        { status: 401 }
      );
    }

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID!,
      process.env.GOOGLE_CLIENT_SECRET!,
      process.env.GOOGLE_REDIRECT_URI!
    );
    oauth2Client.setCredentials({
      access_token: session.accessToken,
      refresh_token: session.refreshToken!,
    });
    const driveClient = google.drive({ version: "v3", auth: oauth2Client });

    const allFiles: drive_v3.Schema$File[] = [];
    let pageToken: string | undefined = undefined;

    do {
      try {
        const q = foldersOnly
          ? `'${folder_id}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`
          : `'${folder_id}' in parents and trashed = false`;
        const listParams: drive_v3.Params$Resource$Files$List = {
          q,
          fields: "nextPageToken, files(id, name, mimeType, createdTime, modifiedTime, size)",
          pageSize: 1000,
          pageToken,
          orderBy: "name",
        };
        const listResponse = await driveClient.files.list(listParams);
        const pageData: drive_v3.Schema$FileList = listResponse.data;
        const fetched: drive_v3.Schema$File[] = pageData.files ?? [];

        console.log(
          `Fetched ${fetched.length} files, nextPageToken=${pageData.nextPageToken}`
        );
        allFiles.push(...fetched);
        pageToken = pageData.nextPageToken ?? undefined;
      } catch (pageErr) {
        console.error(
          `Error fetching a page of folder ${folder_id}:`,
          pageErr
        );
        break;
      }
    } while (pageToken);

    let filesList: FileInfo[] = [];
    try {
      filesList = allFiles.map((f) => ({
        id: f.id!,
        name: f.name!,
        type:
          f.mimeType === "application/vnd.google-apps.folder"
            ? "Folder"
            : "File",
        createdTime: f.createdTime || undefined,
        modifiedTime: f.modifiedTime || undefined,
        size: f.size ? parseInt(f.size, 10) : undefined,
      }));
    } catch (mapErr) {
      console.error("Error mapping files to FileInfo:", mapErr);
      filesList = [];
    }

    return NextResponse.json({ files: filesList });
  } catch (err) {
    console.error("Unexpected error in GET handler:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
