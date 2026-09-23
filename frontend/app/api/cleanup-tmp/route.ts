import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../../lib/authOptions';
import fs from 'fs/promises';
import path from 'path';

interface CleanupResult {
  success: boolean;
  directoriesRemoved: number;
  directoriesKept: number;
  errors: number;
  totalSizeFreed: number;
  message: string;
}

async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;
  try {
    const items = await fs.readdir(dirPath);
    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      const stats = await fs.stat(itemPath);
      if (stats.isDirectory()) {
        totalSize += await getDirectorySize(itemPath);
      } else {
        totalSize += stats.size;
      }
    }
  } catch (err) {
    console.error(`Error calculating size for ${dirPath}:`, err);
  }
  return totalSize;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function cleanupTmpUploadsOcr(maxAgeHours: number = 24): Promise<CleanupResult> {
  const baseTmp = path.join(process.cwd(), 'tmp_uploads_ocr');
  const result: CleanupResult = {
    success: false,
    directoriesRemoved: 0,
    directoriesKept: 0,
    errors: 0,
    totalSizeFreed: 0,
    message: '',
  };

  try {
    console.log('🧹 Starting cleanup of tmp_uploads_ocr...');
    
    try {
      await fs.access(baseTmp);
    } catch {
      result.success = true;
      result.message = 'tmp_uploads_ocr directory does not exist, nothing to clean';
      return result;
    }

    const items = await fs.readdir(baseTmp);
    const now = Date.now();
    const maxAge = maxAgeHours * 60 * 60 * 1000;

    for (const item of items) {
      const itemPath = path.join(baseTmp, item);
      
      try {
        const stats = await fs.stat(itemPath);
        const ageMs = now - stats.mtime.getTime();
        const ageHours = Math.round(ageMs / (60 * 60 * 1000));
        
        if (stats.isDirectory()) {
          if (ageMs > maxAge) {
            const size = await getDirectorySize(itemPath);
            
            console.log(`🗑️ Removing old directory: ${item} (${ageHours}h old, ${formatBytes(size)})`);
            await fs.rm(itemPath, { recursive: true, force: true });
            
            result.directoriesRemoved++;
            result.totalSizeFreed += size;
          } else {
            console.log(`⏳ Keeping recent directory: ${item} (${ageHours}h old)`);
            result.directoriesKept++;
          }
        }
      } catch (err) {
        console.error(`❌ Error processing ${item}:`, err);
        result.errors++;
      }
    }

    const remainingItems = await fs.readdir(baseTmp);
    if (remainingItems.length === 0) {
      console.log('🗂️ Removing empty tmp_uploads_ocr directory');
      await fs.rmdir(baseTmp);
      result.message = `Cleanup completed. Removed ${result.directoriesRemoved} directories (${formatBytes(result.totalSizeFreed)}). Empty tmp_uploads_ocr directory removed.`;
    } else {
      result.message = `Cleanup completed. Removed ${result.directoriesRemoved} directories (${formatBytes(result.totalSizeFreed)}), kept ${result.directoriesKept} recent directories.`;
    }

    result.success = true;
    console.log(`✅ ${result.message}`);

  } catch (err) {
    console.error('❌ Error during tmp_uploads_ocr cleanup:', err);
    result.success = false;
    result.message = `Cleanup failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
  }

  return result;
}

export async function POST(request: Request) {
  console.log('🧹 [START] Manual cleanup request');

  try {
    const session = await getServerSession(authOptions);
    if (!session?.accessToken) {
      console.log('❌ User not authenticated.');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    let maxAgeHours = 24;
    try {
      const body = await request.json();
      if (body.maxAgeHours && typeof body.maxAgeHours === 'number' && body.maxAgeHours > 0) {
        maxAgeHours = body.maxAgeHours;
      }
    } catch {
    }

    console.log(`🔹 Running cleanup with max age: ${maxAgeHours} hours`);
    const result = await cleanupTmpUploadsOcr(maxAgeHours);

    return NextResponse.json({
      success: result.success,
      cleanup: result,
      timestamp: new Date().toISOString(),
    });

  } catch (err: unknown) {
    console.error('❌ Fatal error in cleanup handler:', err);
    const msg = err instanceof Error ? err.message : 'An unknown error occurred during cleanup.';
    return NextResponse.json({ 
      success: false, 
      error: msg,
      timestamp: new Date().toISOString(),
    }, { status: 500 });
  }
}

export async function GET() {
  console.log('📊 [START] Cleanup status request');

  try {
    const session = await getServerSession(authOptions);
    if (!session?.accessToken) {
      console.log('❌ User not authenticated.');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const baseTmp = path.join(process.cwd(), 'tmp_uploads_ocr');
    
    try {
      await fs.access(baseTmp);
    } catch {
      return NextResponse.json({
        exists: false,
        directories: 0,
        totalSize: 0,
        message: 'tmp_uploads_ocr directory does not exist',
        timestamp: new Date().toISOString(),
      });
    }

    const items = await fs.readdir(baseTmp);
    const now = Date.now();
    const directoryInfo = [];
    let totalSize = 0;

    for (const item of items) {
      const itemPath = path.join(baseTmp, item);
      
      try {
        const stats = await fs.stat(itemPath);
        if (stats.isDirectory()) {
          const size = await getDirectorySize(itemPath);
          const ageMs = now - stats.mtime.getTime();
          const ageHours = Math.round(ageMs / (60 * 60 * 1000));
          
          directoryInfo.push({
            name: item,
            ageHours,
            size: formatBytes(size),
            sizeBytes: size,
            lastModified: stats.mtime.toISOString(),
          });
          
          totalSize += size;
        }
      } catch (err) {
        console.error(`Error processing ${item}:`, err);
      }
    }

    directoryInfo.sort((a, b) => b.ageHours - a.ageHours);

    return NextResponse.json({
      exists: true,
      directories: directoryInfo.length,
      directoryDetails: directoryInfo,
      totalSize: formatBytes(totalSize),
      totalSizeBytes: totalSize,
      timestamp: new Date().toISOString(),
    });

  } catch (err: unknown) {
    console.error('❌ Fatal error in status handler:', err);
    const msg = err instanceof Error ? err.message : 'An unknown error occurred while checking status.';
    return NextResponse.json({ 
      error: msg,
      timestamp: new Date().toISOString(),
    }, { status: 500 });
  }
} 