/**
 * Storage Audit & Cleaner
 * Runtime: Node.js bawaan murni (http, fs, path, crypto, child_process)
 * Tidak memerlukan npm install dependensi apa pun.
 *
 * Default Target: C:\Users\Student\Documents\Downloads_Lab
 * Mendukung input path dinamis via Web UI (http://localhost:3000)
 * Fitur Upload/Pilih Folder Tanpa Copy-Paste Path
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { exec } = require('child_process');

const PORT = 3000;
const DEFAULT_TARGET_DIR = 'C:\\Users\\Student\\Documents\\Downloads_Lab';
// Ambang batas File Raksasa: 2.048 KB = 2 * 1024 * 1024 bytes = 2.097.152 bytes (3 MB / 2.048 KB)
const GIANT_FILE_THRESHOLD_BYTES = 2048 * 1024;

// Cache scan terakhir di memori
let currentScanData = null;

// Bersihkan path dari tanda petik ganda/tunggal yang mungkin terbawa saat copy-paste
function sanitizePath(inputPath) {
  if (!inputPath) return '';
  return inputPath.trim().replace(/^["']+|["']+$/g, '').trim();
}

// Format ukuran byte ke format MB dan KB yang informatif
function formatSizeMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function formatSizeKB(bytes) {
  return Math.round(bytes / 1024).toLocaleString('id-ID') + ' KB';
}

function formatBytesReadable(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// Menghitung hash SHA-256 secara streaming agar hemat memori
function getFileSHA256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', err => reject(err));
  });
}

// Rekursif membaca seluruh file dalam folder target dan subfoldernya
async function walkDirectory(dirPath, fileList = []) {
  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    console.error(`Gagal membaca direktori: ${dirPath}`, err.message);
    return fileList;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    try {
      if (entry.isDirectory()) {
        await walkDirectory(fullPath, fileList);
      } else if (entry.isFile()) {
        const stats = await fs.promises.stat(fullPath);
        fileList.push({
          name: entry.name,
          path: fullPath,
          size: stats.size,
          mtime: stats.mtime,
          ctime: stats.ctime,
          ext: path.extname(entry.name).toLowerCase()
        });
      }
    } catch (err) {
      console.warn(`Peringatan akses file: ${fullPath} (${err.message})`);
    }
  }

  return fileList;
}

// Deteksi prioritas file asli vs salinan (heuristik cerdas)
function isLikelyCopyName(fileName) {
  const lower = fileName.toLowerCase();
  const copyIndicators = [
    ' - copy',
    ' - salinan',
    '_copy',
    '_backup',
    'backup_',
    ' (1)',
    ' (2)',
    ' (3)',
    '_v2',
    '_edit',
    'edit2',
    '_fix',
    '_final'
  ];
  return copyIndicators.some(indicator => lower.includes(indicator));
}

// Pencari cerdas path folder di sistem operasi saat folder dipilih via Web UI
function locateFolderOnSystem(folderName, sampleFileNames = []) {
  const homeDir = os.homedir();
  const candidateBases = [
    path.join(homeDir, 'Desktop'),
    path.join(homeDir, 'Documents'),
    path.join(homeDir, 'Downloads'),
    homeDir,
    process.cwd(),
    'C:\\',
    'D:\\'
  ];

  // 1. Cek langsung di base paths
  for (const base of candidateBases) {
    if (!fs.existsSync(base)) continue;
    const candidate = path.join(base, folderName);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        if (sampleFileNames && sampleFileNames.length > 0) {
          const matched = sampleFileNames.some(sf => fs.existsSync(path.join(candidate, sf)));
          if (matched) return candidate;
        } else {
          return candidate;
        }
      }
    } catch (_) {}
  }

  // 2. Cek subdirektori 1-level di Documents dan Desktop
  const nestedBases = [path.join(homeDir, 'Documents'), path.join(homeDir, 'Desktop'), process.cwd()];
  for (const base of nestedBases) {
    if (!fs.existsSync(base)) continue;
    try {
      const subdirs = fs.readdirSync(base, { withFileTypes: true });
      for (const sd of subdirs) {
        if (sd.isDirectory()) {
          const subCandidate = path.join(base, sd.name, folderName);
          if (fs.existsSync(subCandidate) && fs.statSync(subCandidate).isDirectory()) {
            return subCandidate;
          }
        }
      }
    } catch (_) {}
  }

  // Fallback ke pencocokan pertama yang ada
  for (const base of candidateBases) {
    if (!fs.existsSync(base)) continue;
    const candidate = path.join(base, folderName);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  return null;
}

// Memproses pemindaian folder target secara komprehensif
async function performScan(targetFolder) {
  const cleanedPath = sanitizePath(targetFolder);
  const normalizedTarget = path.resolve(cleanedPath);
  if (!fs.existsSync(normalizedTarget)) {
    throw new Error(`Direktori tidak ditemukan: ${normalizedTarget}`);
  }

  const stat = await fs.promises.stat(normalizedTarget);
  if (!stat.isDirectory()) {
    throw new Error(`Path bukan merupakan sebuah folder: ${normalizedTarget}`);
  }

  const rawFiles = await walkDirectory(normalizedTarget);
  const processedFiles = [];

  // Hitung SHA-256 untuk setiap file
  for (const file of rawFiles) {
    try {
      const hash = await getFileSHA256(file.path);
      const isGiant = file.size >= GIANT_FILE_THRESHOLD_BYTES;
      const isTemp = file.ext === '.tmp' || file.name.startsWith('~$') || file.name.endsWith('.tmp');

      processedFiles.push({
        name: file.name,
        path: file.path,
        relPath: path.relative(normalizedTarget, file.path),
        size: file.size,
        sizeMB: formatSizeMB(file.size),
        sizeKB: formatSizeKB(file.size),
        sizeFormatted: `${formatSizeMB(file.size)} (${formatSizeKB(file.size)})`,
        readableSize: formatBytesReadable(file.size),
        hash: hash,
        mtime: file.mtime,
        ext: file.ext || 'tanpa ekstensi',
        isGiant: isGiant,
        isTemp: isTemp
      });
    } catch (err) {
      console.warn(`Gagal hash file: ${file.path} (${err.message})`);
    }
  }

  // Pengelompokan file berdasarkan SHA-256 identik
  const hashMap = new Map();
  for (const file of processedFiles) {
    if (!hashMap.has(file.hash)) {
      hashMap.set(file.hash, []);
    }
    hashMap.get(file.hash).push(file);
  }

  // Bentuk grup duplikat (kelompok yang memiliki 2+ file identik)
  const duplicateGroups = [];
  let totalRedundantBytes = 0;
  let totalDuplicateCopiesCount = 0;

  for (const [hash, files] of hashMap.entries()) {
    if (files.length > 1) {
      files.sort((a, b) => {
        const aIsCopy = isLikelyCopyName(a.name) ? 1 : 0;
        const bIsCopy = isLikelyCopyName(b.name) ? 1 : 0;
        if (aIsCopy !== bIsCopy) return aIsCopy - bIsCopy;
        if (a.name.length !== b.name.length) return a.name.length - b.name.length;
        return new Date(a.mtime) - new Date(b.mtime);
      });

      // Tandai file asli vs salinan
      const taggedFiles = files.map((f, idx) => ({
        ...f,
        isOriginal: idx === 0,
        canDelete: idx > 0
      }));

      const oneSize = taggedFiles[0].size;
      const copiesCount = taggedFiles.length;
      const redundantBytes = oneSize * (copiesCount - 1);
      totalRedundantBytes += redundantBytes;
      totalDuplicateCopiesCount += copiesCount - 1;

      duplicateGroups.push({
        groupId: hash.substring(0, 12),
        hash: hash,
        fileSize: oneSize,
        sizeFormatted: `${formatSizeMB(oneSize)} (${formatSizeKB(oneSize)})`,
        readableSize: formatBytesReadable(oneSize),
        copiesCount: copiesCount,
        redundantBytes: redundantBytes,
        redundantFormatted: formatBytesReadable(redundantBytes),
        representativeName: taggedFiles[0].name,
        files: taggedFiles
      });
    }
  }

  duplicateGroups.sort((a, b) => b.redundantBytes - a.redundantBytes);

  // File Raksasa (ambang batas >= 2.048 KB / 3 MB)
  const giantFiles = processedFiles
    .filter(f => f.isGiant)
    .sort((a, b) => b.size - a.size);

  // File Sampah (.tmp)
  const tempFiles = processedFiles.filter(f => f.isTemp);
  const tempFilesBytes = tempFiles.reduce((acc, f) => acc + f.size, 0);

  // Potensi Hemat Total
  const tempNonDuplicateBytes = tempFiles
    .filter(tf => !duplicateGroups.some(g => g.files.some(f => f.path === tf.path && !f.isOriginal)))
    .reduce((acc, f) => acc + f.size, 0);

  const totalSavingsBytes = totalRedundantBytes + tempNonDuplicateBytes;
  const totalSizeBytes = processedFiles.reduce((acc, f) => acc + f.size, 0);

  const result = {
    targetFolder: normalizedTarget,
    scanTimestamp: new Date().toISOString(),
    metrics: {
      totalFiles: processedFiles.length,
      totalSizeBytes: totalSizeBytes,
      totalSizeFormatted: formatBytesReadable(totalSizeBytes),
      totalSizeDetailed: `${formatSizeMB(totalSizeBytes)} (${formatSizeKB(totalSizeBytes)})`,
      duplicateGroupsCount: duplicateGroups.length,
      duplicateCopiesCount: totalDuplicateCopiesCount,
      giantFilesCount: giantFiles.length,
      giantThresholdBytes: GIANT_FILE_THRESHOLD_BYTES,
      giantThresholdFormatted: '3 MB (2.048 KB)',
      tempFilesCount: tempFiles.length,
      tempFilesBytes: tempFilesBytes,
      potentialSavingsBytes: totalSavingsBytes,
      potentialSavingsFormatted: formatBytesReadable(totalSavingsBytes),
      potentialSavingsDetailed: `${formatSizeMB(totalSavingsBytes)} (${formatSizeKB(totalSavingsBytes)})`
    },
    duplicateGroups: duplicateGroups,
    giantFiles: giantFiles,
    tempFiles: tempFiles,
    allFiles: processedFiles
  };

  currentScanData = result;
  return result;
}

// Pembersihan Langsung di Tempat (In-Place Deletion)
async function performCleaning(targetFolder) {
  const cleaned = sanitizePath(targetFolder);
  if (!currentScanData || currentScanData.targetFolder !== path.resolve(cleaned)) {
    await performScan(cleaned);
  }

  const filesToDelete = [];
  let plannedFreedBytes = 0;

  for (const group of currentScanData.duplicateGroups) {
    for (const f of group.files) {
      if (!f.isOriginal && f.canDelete) {
        filesToDelete.push({
          path: f.path,
          name: f.name,
          size: f.size,
          reason: `Salinan Duplikat dari ${group.representativeName}`
        });
        plannedFreedBytes += f.size;
      }
    }
  }

  for (const tf of currentScanData.tempFiles) {
    if (!filesToDelete.some(item => item.path === tf.path)) {
      filesToDelete.push({
        path: tf.path,
        name: tf.name,
        size: tf.size,
        reason: 'File Sampah Sementara (.tmp)'
      });
      plannedFreedBytes += tf.size;
    }
  }

  let deletedCount = 0;
  let actuallyFreedBytes = 0;
  const errors = [];

  for (const item of filesToDelete) {
    try {
      if (fs.existsSync(item.path)) {
        await fs.promises.unlink(item.path);
        deletedCount++;
        actuallyFreedBytes += item.size;
      }
    } catch (err) {
      errors.push({
        path: item.path,
        error: err.message
      });
      console.error(`Gagal menghapus file ${item.path}:`, err.message);
    }
  }

  const updatedScan = await performScan(cleaned);

  return {
    success: true,
    deletedCount: deletedCount,
    freedBytes: actuallyFreedBytes,
    freedFormatted: formatBytesReadable(actuallyFreedBytes),
    errors: errors,
    updatedScan: updatedScan
  };
}

// HTML Dashboard UI Modern (Single Page Responsive UI dengan Tombol Upload Folder)
function getDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Storage Audit & Cleaner - Native Node.js</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-dark: #090d16;
      --card-bg: rgba(18, 24, 38, 0.78);
      --card-border: rgba(255, 255, 255, 0.08);
      --card-hover: rgba(26, 34, 52, 0.9);
      --text-main: #f1f5f9;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --primary: #38bdf8;
      --primary-glow: rgba(56, 189, 248, 0.35);
      --accent: #6366f1;
      --accent-glow: rgba(99, 102, 241, 0.35);
      --success: #10b981;
      --success-glow: rgba(16, 185, 129, 0.3);
      --warning: #f59e0b;
      --danger: #f43f5e;
      --danger-glow: rgba(244, 63, 94, 0.35);
      --radius: 14px;
      --radius-sm: 8px;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg-dark);
      background-image: 
        radial-gradient(at 0% 0%, rgba(99, 102, 241, 0.15) 0px, transparent 50%),
        radial-gradient(at 100% 0%, rgba(56, 189, 248, 0.12) 0px, transparent 50%),
        radial-gradient(at 50% 100%, rgba(16, 185, 129, 0.08) 0px, transparent 50%);
      background-attachment: fixed;
      color: var(--text-main);
      font-family: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      overflow-x: hidden;
    }

    .container {
      max-width: 1280px;
      margin: 0 auto;
      padding: 24px 20px 48px;
      width: 100%;
    }

    /* HEADER */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 28px;
      flex-wrap: wrap;
      gap: 16px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .brand-icon {
      width: 46px;
      height: 46px;
      background: linear-gradient(135deg, #0ea5e9, #6366f1);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      box-shadow: 0 8px 20px rgba(14, 165, 233, 0.3);
    }

    .brand h1 {
      font-size: 1.5rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      background: linear-gradient(90deg, #ffffff, #93c5fd);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .brand p {
      font-size: 0.85rem;
      color: var(--text-muted);
    }

    .badge-runtime {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      background: rgba(16, 185, 129, 0.12);
      border: 1px solid rgba(16, 185, 129, 0.3);
      border-radius: 999px;
      color: #34d399;
      font-size: 0.8rem;
      font-weight: 600;
    }

    .badge-runtime .dot {
      width: 8px;
      height: 8px;
      background: #10b981;
      border-radius: 50%;
      box-shadow: 0 0 10px #10b981;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }

    /* CONTROL PANEL */
    .control-panel {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius);
      padding: 22px;
      backdrop-filter: blur(16px);
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.35);
      margin-bottom: 28px;
    }

    .path-input-group {
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
    }

    .input-wrapper {
      position: relative;
      flex: 1;
      min-width: 280px;
    }

    .input-wrapper span.icon {
      position: absolute;
      left: 14px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-dim);
      font-size: 1.1rem;
    }

    .path-input {
      width: 100%;
      padding: 13px 16px 13px 44px;
      background: rgba(11, 15, 25, 0.8);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 10px;
      color: #ffffff;
      font-size: 0.95rem;
      font-family: 'JetBrains Mono', monospace;
      outline: none;
      transition: all 0.2s ease;
    }

    .path-input:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px var(--primary-glow);
    }

    .btn {
      padding: 13px 20px;
      border-radius: 10px;
      font-size: 0.92rem;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: none;
      transition: all 0.2s ease;
      white-space: nowrap;
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none !important;
    }

    .btn-upload {
      background: linear-gradient(135deg, #4f46e5, #7c3aed);
      color: #ffffff;
      box-shadow: 0 4px 14px rgba(79, 70, 229, 0.35);
      border: 1px solid rgba(255, 255, 255, 0.15);
    }

    .btn-upload:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(124, 58, 237, 0.5);
    }

    .btn-browse {
      background: rgba(255, 255, 255, 0.08);
      color: #e2e8f0;
      border: 1px solid rgba(255, 255, 255, 0.12);
    }

    .btn-browse:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.15);
      color: #ffffff;
    }

    .btn-primary {
      background: linear-gradient(135deg, #0284c7, #2563eb);
      color: #ffffff;
      box-shadow: 0 4px 14px rgba(2, 132, 199, 0.3);
    }

    .btn-primary:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(2, 132, 199, 0.45);
    }

    .btn-danger {
      background: linear-gradient(135deg, #e11d48, #be123c);
      color: #ffffff;
      box-shadow: 0 4px 14px rgba(225, 29, 72, 0.35);
    }

    .btn-danger:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(225, 29, 72, 0.5);
    }

    .quick-presets {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 14px;
      font-size: 0.82rem;
      color: var(--text-dim);
      flex-wrap: wrap;
    }

    .preset-pill {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 4px 10px;
      border-radius: 6px;
      cursor: pointer;
      color: var(--text-muted);
      transition: all 0.15s ease;
      font-family: 'JetBrains Mono', monospace;
    }

    .preset-pill:hover {
      background: rgba(56, 189, 248, 0.15);
      border-color: rgba(56, 189, 248, 0.3);
      color: var(--primary);
    }

    /* METRIC CARDS */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 18px;
      margin-bottom: 28px;
    }

    .metric-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius);
      padding: 20px;
      backdrop-filter: blur(14px);
      transition: transform 0.2s ease, border-color 0.2s ease;
      position: relative;
      overflow: hidden;
    }

    .metric-card:hover {
      transform: translateY(-2px);
      border-color: rgba(255, 255, 255, 0.16);
    }

    .metric-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: transparent;
    }

    .metric-card.card-blue::before { background: linear-gradient(90deg, #38bdf8, #6366f1); }
    .metric-card.card-purple::before { background: linear-gradient(90deg, #818cf8, #c084fc); }
    .metric-card.card-amber::before { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
    .metric-card.card-emerald::before { background: linear-gradient(90deg, #10b981, #34d399); }

    .metric-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .metric-title {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .metric-icon {
      font-size: 1.25rem;
      width: 36px;
      height: 36px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.05);
    }

    .metric-value {
      font-size: 2.1rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: #ffffff;
      line-height: 1.1;
      margin-bottom: 6px;
    }

    .metric-sub {
      font-size: 0.8rem;
      color: var(--text-dim);
    }

    .highlight-savings {
      color: #34d399;
      font-weight: 600;
    }

    /* TABS */
    .tabs-nav {
      display: flex;
      gap: 10px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 22px;
      overflow-x: auto;
      padding-bottom: 2px;
    }

    .tab-btn {
      padding: 12px 18px;
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      position: relative;
      transition: all 0.2s ease;
      font-family: inherit;
    }

    .tab-btn:hover {
      color: #ffffff;
    }

    .tab-btn.active {
      color: var(--primary);
    }

    .tab-btn.active::after {
      content: '';
      position: absolute;
      bottom: -3px;
      left: 0;
      right: 0;
      height: 3px;
      background: var(--primary);
      border-radius: 3px 3px 0 0;
      box-shadow: 0 0 10px var(--primary);
    }

    .tab-pill {
      font-size: 0.75rem;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-muted);
      font-weight: 700;
    }

    .tab-btn.active .tab-pill {
      background: rgba(56, 189, 248, 0.2);
      color: var(--primary);
    }

    /* TAB CONTENT */
    .tab-content {
      display: none;
    }

    .tab-content.active {
      display: block;
      animation: fadeIn 0.25s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* DUPLICATE ACCORDION */
    .accordion-list {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .accordion-item {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius);
      overflow: hidden;
      transition: all 0.2s ease;
    }

    .accordion-item:hover {
      border-color: rgba(255, 255, 255, 0.14);
    }

    .accordion-header {
      padding: 16px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      user-select: none;
      background: rgba(255, 255, 255, 0.02);
      transition: background 0.2s;
    }

    .accordion-header:hover {
      background: rgba(255, 255, 255, 0.04);
    }

    .accordion-left {
      display: flex;
      align-items: center;
      gap: 14px;
      flex: 1;
      min-width: 0;
    }

    .accordion-idx {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.06);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.8rem;
      font-weight: 700;
      color: var(--text-muted);
    }

    .accordion-info {
      min-width: 0;
    }

    .accordion-title {
      font-size: 0.98rem;
      font-weight: 600;
      color: #ffffff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .accordion-meta {
      font-size: 0.8rem;
      color: var(--text-dim);
      display: flex;
      gap: 12px;
      margin-top: 3px;
    }

    .accordion-right {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-left: 12px;
    }

    .badge-count {
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(244, 63, 94, 0.15);
      color: #fb7185;
      border: 1px solid rgba(244, 63, 94, 0.25);
      font-size: 0.8rem;
      font-weight: 600;
      white-space: nowrap;
    }

    .badge-saved {
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.25);
      font-size: 0.8rem;
      font-weight: 600;
      white-space: nowrap;
    }

    .chevron {
      color: var(--text-dim);
      transition: transform 0.25s ease;
      font-size: 1.1rem;
    }

    .accordion-item.expanded .chevron {
      transform: rotate(180deg);
    }

    .accordion-body {
      display: none;
      padding: 18px 20px;
      border-top: 1px solid var(--card-border);
      background: rgba(10, 14, 24, 0.6);
    }

    .accordion-item.expanded .accordion-body {
      display: block;
    }

    .hash-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 14px;
      background: rgba(0, 0, 0, 0.3);
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 0.8rem;
    }

    .hash-label {
      color: var(--text-dim);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 0.72rem;
    }

    .hash-code {
      font-family: 'JetBrains Mono', monospace;
      color: #38bdf8;
      word-break: break-all;
      flex: 1;
    }

    .btn-copy {
      background: rgba(255, 255, 255, 0.08);
      border: none;
      color: var(--text-muted);
      padding: 4px 10px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.75rem;
      transition: all 0.15s;
    }

    .btn-copy:hover {
      background: rgba(255, 255, 255, 0.15);
      color: #ffffff;
    }

    .file-items {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .file-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 14px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 8px;
      gap: 12px;
    }

    .file-item.original {
      border-color: rgba(16, 185, 129, 0.3);
      background: rgba(16, 185, 129, 0.04);
    }

    .file-item.copy {
      border-color: rgba(244, 63, 94, 0.2);
    }

    .file-details {
      min-width: 0;
      flex: 1;
    }

    .file-name {
      font-size: 0.9rem;
      font-weight: 600;
      color: #f8fafc;
      word-break: break-all;
    }

    .file-path {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
      color: var(--text-dim);
      word-break: break-all;
      margin-top: 2px;
    }

    .file-tag {
      font-size: 0.72rem;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 6px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }

    .tag-keep {
      background: rgba(16, 185, 129, 0.18);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.35);
    }

    .tag-delete {
      background: rgba(244, 63, 94, 0.18);
      color: #fb7185;
      border: 1px solid rgba(244, 63, 94, 0.35);
    }

    /* TABLE */
    .table-container {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius);
      overflow-x: auto;
      backdrop-filter: blur(14px);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.9rem;
    }

    thead th {
      background: rgba(255, 255, 255, 0.03);
      padding: 14px 18px;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
      border-bottom: 1px solid var(--card-border);
    }

    tbody td {
      padding: 14px 18px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      color: var(--text-main);
      vertical-align: middle;
    }

    tbody tr:hover {
      background: rgba(255, 255, 255, 0.02);
    }

    tbody tr:last-child td {
      border-bottom: none;
    }

    .table-filename {
      font-weight: 600;
      color: #ffffff;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .ext-badge {
      font-size: 0.72rem;
      padding: 2px 7px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--primary);
      font-family: 'JetBrains Mono', monospace;
      text-transform: uppercase;
    }

    .size-badge-giant {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 6px;
      background: rgba(245, 158, 11, 0.15);
      border: 1px solid rgba(245, 158, 11, 0.3);
      color: #fbbf24;
      font-weight: 600;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
    }

    /* MODAL */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;
      padding: 20px;
    }

    .modal-overlay.active {
      opacity: 1;
      pointer-events: auto;
    }

    .modal-card {
      background: #111726;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 18px;
      width: 100%;
      max-width: 620px;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.7);
      transform: scale(0.95);
      transition: transform 0.2s ease;
    }

    .modal-danger-card {
      border-color: rgba(244, 63, 94, 0.35);
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.7), 0 0 40px rgba(244, 63, 94, 0.15);
    }

    .modal-overlay.active .modal-card {
      transform: scale(1);
    }

    .modal-header {
      padding: 20px 24px;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
    }

    .modal-title-wrap {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .modal-icon-danger {
      width: 42px;
      height: 42px;
      background: rgba(244, 63, 94, 0.15);
      border: 1px solid rgba(244, 63, 94, 0.3);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      color: #f43f5e;
    }

    .modal-icon-explorer {
      width: 42px;
      height: 42px;
      background: rgba(99, 102, 241, 0.15);
      border: 1px solid rgba(99, 102, 241, 0.3);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      color: #818cf8;
    }

    .modal-header h3 {
      font-size: 1.2rem;
      font-weight: 700;
      color: #ffffff;
    }

    .modal-close-btn {
      background: none;
      border: none;
      color: var(--text-dim);
      font-size: 1.4rem;
      cursor: pointer;
      line-height: 1;
    }

    .modal-close-btn:hover {
      color: #ffffff;
    }

    .modal-body {
      padding: 20px 24px;
      overflow-y: auto;
      flex: 1;
      font-size: 0.92rem;
      line-height: 1.6;
      color: #cbd5e1;
    }

    .modal-stats {
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 10px;
      padding: 14px 18px;
      margin: 16px 0;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .modal-stat-label {
      font-size: 0.78rem;
      color: var(--text-dim);
      text-transform: uppercase;
    }

    .modal-stat-val {
      font-size: 1.25rem;
      font-weight: 700;
      color: #ffffff;
    }

    .clean-file-list {
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 8px;
      max-height: 180px;
      overflow-y: auto;
      padding: 8px 12px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.76rem;
      color: #94a3b8;
    }

    .clean-file-list-item {
      padding: 5px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.03);
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }

    .clean-file-list-item:last-child {
      border-bottom: none;
    }

    .modal-footer {
      padding: 18px 24px;
      border-top: 1px solid var(--card-border);
      display: flex;
      justify-content: flex-end;
      gap: 12px;
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-main);
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.14);
    }

    /* DIRECTORY EXPLORER MODAL */
    .explorer-path-bar {
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      padding: 8px 12px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      color: var(--primary);
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
      overflow-x: auto;
      white-space: nowrap;
    }

    .dir-items-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 280px;
      overflow-y: auto;
      padding-right: 4px;
    }

    .dir-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .dir-item:hover {
      background: rgba(56, 189, 248, 0.1);
      border-color: rgba(56, 189, 248, 0.3);
      color: #ffffff;
    }

    .dir-item-name {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 500;
      font-size: 0.92rem;
    }

    .dir-item-actions {
      display: flex;
      gap: 6px;
    }

    .btn-mini {
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 0.76rem;
      cursor: pointer;
      border: none;
    }

    .btn-mini-primary {
      background: rgba(16, 185, 129, 0.2);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.35);
      font-weight: 600;
    }

    .btn-mini-primary:hover {
      background: #10b981;
      color: #ffffff;
    }

    /* TOAST */
    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      padding: 14px 20px;
      background: #1e293b;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 10px;
      color: #ffffff;
      font-size: 0.9rem;
      display: flex;
      align-items: center;
      gap: 10px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      transform: translateY(100px);
      opacity: 0;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 1100;
    }

    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }

    .toast.success {
      border-color: rgba(16, 185, 129, 0.4);
      background: #064e3b;
    }

    .toast.error {
      border-color: rgba(244, 63, 94, 0.4);
      background: #4c0519;
    }

    /* EMPTY / LOADING STATE */
    .empty-state {
      text-align: center;
      padding: 48px 20px;
      color: var(--text-dim);
    }

    .empty-state-icon {
      font-size: 3rem;
      margin-bottom: 12px;
      opacity: 0.6;
    }

    .spinner {
      display: inline-block;
      width: 18px;
      height: 18px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      border-top-color: #ffffff;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* FOOTER */
    footer {
      margin-top: auto;
      text-align: center;
      padding: 24px;
      font-size: 0.8rem;
      color: var(--text-dim);
      border-top: 1px solid var(--card-border);
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <div class="brand-icon">⚡</div>
        <div>
          <h1>Storage Audit & Cleaner</h1>
          <p>Utilitas Manajemen & Audit Penyimpanan Berbasis Node.js Murni</p>
        </div>
      </div>
      <div class="badge-runtime">
        <span class="dot"></span>
        Runtime Node.js Standar (Tanpa npm)
      </div>
    </header>

    <!-- CONTROL PANEL: INPUT PATH DINAMIS, UPLOAD FOLDER, JELAJAHI FOLDER & AKSI -->
    <section class="control-panel">
      <!-- Hidden Webkit Directory Input untuk Upload Folder langsung -->
      <input 
        type="file" 
        id="folderPickerInput" 
        webkitdirectory 
        directory 
        multiple 
        style="display: none;" 
        onchange="handleFolderSelected(event)"
      >

      <div class="path-input-group">
        <div class="input-wrapper">
          <span class="icon">📁</span>
          <input 
            type="text" 
            id="targetPathInput" 
            class="path-input" 
            placeholder="Masukkan path folder atau klik 'Upload / Pilih Folder'" 
            value="C:\\Users\\Student\\Documents\\Downloads_Lab"
            spellcheck="false"
            onchange="cleanInputQuotes(this)"
          >
        </div>

        <!-- TOMBOL UPLOAD / PILIH FOLDER -->
        <button id="btnUploadFolder" class="btn btn-upload" onclick="triggerFolderUploadPicker()" title="Pilih folder secara visual dari komputer tanpa perlu copy-paste path">
          <span>📂</span>
          <span>Upload / Pilih Folder</span>
        </button>

        <!-- TOMBOL JELAJAHI FOLDER (DIRECTORY EXPLORER) -->
        <button class="btn btn-browse" onclick="openDirectoryModal()" title="Buka penjelajah direktori interaktif">
          <span>🧭</span>
          <span>Jelajahi...</span>
        </button>

        <button id="btnScan" class="btn btn-primary" onclick="triggerScan()">
          <span id="scanSpinner" class="spinner" style="display: none;"></span>
          <span id="scanIcon">🔍</span>
          <span>Pindai Folder</span>
        </button>

        <button id="btnClean" class="btn btn-danger" onclick="openCleanModal()" disabled>
          <span>🧹</span>
          <span>Bersihkan Duplikat & Sampah</span>
        </button>
      </div>

      <div class="quick-presets">
        <span>Akses Cepat:</span>
        <span class="preset-pill" onclick="setPresetPath('C:\\\\Users\\\\Student\\\\Documents\\\\Downloads_Lab')">Downloads_Lab (Documents)</span>
        <span class="preset-pill" onclick="setPresetPath('C:\\\\Users\\\\Student\\\\Desktop\\\\Downloads_Lab')">Downloads_Lab (Desktop)</span>
        <span class="preset-pill" onclick="setPresetPath('c:\\\\Users\\\\Student\\\\Documents\\\\storage-cleaner\\\\sample_test_data')">sample_test_data</span>
        <span class="preset-pill" onclick="setPresetPath('C:\\\\Users\\\\Student\\\\Documents')">Documents</span>
        <span class="preset-pill" onclick="setPresetPath('C:\\\\Users\\\\Student\\\\Desktop')">Desktop</span>
      </div>
    </section>

    <!-- 4 KARTU METRIK STORAGE SESUAI SRS -->
    <section class="metrics-grid">
      <!-- 1. Total File -->
      <div class="metric-card card-blue">
        <div class="metric-header">
          <span class="metric-title">Total File</span>
          <div class="metric-icon">📑</div>
        </div>
        <div class="metric-value" id="valTotalFiles">-</div>
        <div class="metric-sub" id="subTotalFiles">Termasuk seluruh subfolder</div>
      </div>

      <!-- 2. Total Kapasitas -->
      <div class="metric-card card-purple">
        <div class="metric-header">
          <span class="metric-title">Total Kapasitas</span>
          <div class="metric-icon">💾</div>
        </div>
        <div class="metric-value" id="valTotalCapacity">-</div>
        <div class="metric-sub" id="subTotalCapacity">Ruang penyimpanan terpakai</div>
      </div>

      <!-- 3. File Raksasa (Ambang Batas 3 MB / 2.048 KB) -->
      <div class="metric-card card-amber">
        <div class="metric-header">
          <span class="metric-title">File Raksasa</span>
          <div class="metric-icon">⚠️</div>
        </div>
        <div class="metric-value" id="valGiantFiles">-</div>
        <div class="metric-sub">Ambang batas: ≥ 2.048 KB (3 MB)</div>
      </div>

      <!-- 4. Potensi Hemat (Duplikat & Sampah) -->
      <div class="metric-card card-emerald">
        <div class="metric-header">
          <span class="metric-title">Potensi Hemat</span>
          <div class="metric-icon">✨</div>
        </div>
        <div class="metric-value highlight-savings" id="valSavings">-</div>
        <div class="metric-sub" id="subSavings">Dari salinan kembar & file .tmp</div>
      </div>
    </section>

    <!-- TABS NAVIGASI -->
    <nav class="tabs-nav">
      <button class="tab-btn active" onclick="switchTab('tabDuplicates')">
        <span>👥 Kelompok Duplikat</span>
        <span class="tab-pill" id="pillDuplicates">0</span>
      </button>
      <button class="tab-btn" onclick="switchTab('tabGiants')">
        <span>📦 File Raksasa</span>
        <span class="tab-pill" id="pillGiants">0</span>
      </button>
      <button class="tab-btn" onclick="switchTab('tabTemp')">
        <span>🗑️ File Sampah (.tmp)</span>
        <span class="tab-pill" id="pillTemp">0</span>
      </button>
      <button class="tab-btn" onclick="switchTab('tabAll')">
        <span>📑 Semua File</span>
        <span class="tab-pill" id="pillAll">0</span>
      </button>
    </nav>

    <!-- TAB 1: KELOMPOK DUPLIKAT (ACCORDION) -->
    <section id="tabDuplicates" class="tab-content active">
      <div id="duplicateList" class="accordion-list">
        <div class="empty-state">
          <div class="empty-state-icon">🔍</div>
          <p>Klik "Pindai Folder" untuk mulai menganalisis duplikat.</p>
        </div>
      </div>
    </section>

    <!-- TAB 2: FILE RAKSASA (TABEL) -->
    <section id="tabGiants" class="tab-content">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Nama File</th>
              <th>Ukuran (MB & KB)</th>
              <th>Format</th>
              <th>Path Lengkap</th>
              <th>Waktu Diubah</th>
            </tr>
          </thead>
          <tbody id="giantTableBody">
            <tr>
              <td colspan="6" class="empty-state">Belum ada data dipindai.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- TAB 3: FILE SAMPAH (.tmp) -->
    <section id="tabTemp" class="tab-content">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Nama File</th>
              <th>Ukuran</th>
              <th>Path Lengkap</th>
              <th>Tindakan Pembersihan</th>
            </tr>
          </thead>
          <tbody id="tempTableBody">
            <tr>
              <td colspan="5" class="empty-state">Belum ada data dipindai.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- TAB 4: SEMUA FILE -->
    <section id="tabAll" class="tab-content">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Nama File</th>
              <th>Ukuran</th>
              <th>Hash SHA-256</th>
              <th>Path Lengkap</th>
            </tr>
          </thead>
          <tbody id="allFilesTableBody">
            <tr>
              <td colspan="5" class="empty-state">Belum ada data dipindai.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>

  <!-- MODAL PENJELAJAH DIREKTORI (VISUAL FOLDER EXPLORER) -->
  <div id="dirExplorerModal" class="modal-overlay">
    <div class="modal-card">
      <div class="modal-header">
        <div class="modal-title-wrap">
          <div class="modal-icon-explorer">🧭</div>
          <div>
            <h3>Jelajahi Folder Komputer</h3>
            <p style="font-size: 0.8rem; color: var(--text-dim);">Pilih folder penyimpanan tanpa mengetik path</p>
          </div>
        </div>
        <button class="modal-close-btn" onclick="closeDirectoryModal()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="explorer-path-bar" id="explorerCurrentPath">C:\\...</div>
        
        <div style="display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap;">
          <button class="btn-mini btn-secondary" onclick="browseDirectory('C:\\\\Users\\\\Student\\\\Documents')">📁 Documents</button>
          <button class="btn-mini btn-secondary" onclick="browseDirectory('C:\\\\Users\\\\Student\\\\Desktop')">💻 Desktop</button>
          <button class="btn-mini btn-secondary" onclick="browseDirectory('C:\\\\Users\\\\Student\\\\Downloads')">📥 Downloads</button>
          <button class="btn-mini btn-secondary" onclick="browseDirectory('C:\\\\')">💽 Drive C:\\</button>
        </div>

        <div id="dirListContainer" class="dir-items-list">
          <div class="empty-state">Memuat direktori...</div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeDirectoryModal()">Tutup</button>
        <button id="btnSelectCurrentDir" class="btn btn-primary" onclick="selectCurrentExploredDir()">
          <span>✓</span>
          <span>Pilih Folder Ini & Pindai</span>
        </button>
      </div>
    </div>
  </div>

  <!-- MODAL KONFIRMASI INTERAKTIF PEMBERSIHAN IN-PLACE -->
  <div id="cleanModal" class="modal-overlay">
    <div class="modal-card modal-danger-card">
      <div class="modal-header">
        <div class="modal-title-wrap">
          <div class="modal-icon-danger">⚠️</div>
          <div>
            <h3>Konfirmasi Pembersihan Penyimpanan</h3>
            <p style="font-size: 0.8rem; color: var(--text-dim);">Pembersihan berdampak langsung pada folder target (In-Place)</p>
          </div>
        </div>
        <button class="modal-close-btn" onclick="closeCleanModal()">&times;</button>
      </div>
      <div class="modal-body">
        <p>Anda akan melakukan pembersihan langsung pada folder target. Hanya <strong>file salinan kembar</strong> dan <strong>file .tmp</strong> yang akan dihapus.</p>
        <p style="margin-top: 6px; color: #34d399; font-weight: 500;">
          🛡️ Jaminan Keamanan: Tepat <strong>1 file asli per kelompok duplikat</strong> akan selalu dipertahankan utuh.
        </p>

        <div class="modal-stats">
          <div>
            <div class="modal-stat-label">File Akan Dihapus</div>
            <div class="modal-stat-val" id="modalFilesCount">-</div>
          </div>
          <div>
            <div class="modal-stat-label">Ruang Dibebaskan</div>
            <div class="modal-stat-val" style="color: #34d399;" id="modalSavedBytes">-</div>
          </div>
        </div>

        <p style="font-size: 0.82rem; color: var(--text-muted); margin-bottom: 8px;">Daftar File yang akan Dihapus Secara Permanen:</p>
        <div id="modalFilesList" class="clean-file-list"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeCleanModal()">Batal</button>
        <button id="btnConfirmClean" class="btn btn-danger" onclick="executeClean()">
          <span id="cleanSpinner" class="spinner" style="display: none;"></span>
          <span id="cleanIcon">🗑️</span>
          <span>Ya, Eksekusi Pembersihan Sekarang</span>
        </button>
      </div>
    </div>
  </div>

  <!-- TOAST NOTIFICATION -->
  <div id="toast" class="toast">
    <span id="toastIcon">ℹ️</span>
    <span id="toastMsg">Pesan</span>
  </div>

  <footer>
    Storage Audit & Cleaner — Node.js Standard Runtime Edition &bull; Port 3000
  </footer>

  <script>
    let scanData = null;
    let activeExploredPath = '';

    function cleanInputQuotes(inputEl) {
      if (!inputEl) return;
      inputEl.value = inputEl.value.trim().replace(/^["']+|["']+$/g, '').trim();
    }

    // Klik tombol Upload Folder membuka dialog pemilihan folder OS
    function triggerFolderUploadPicker() {
      const picker = document.getElementById('folderPickerInput');
      picker.value = ''; // reset agar bisa memilih folder yang sama
      picker.click();
    }

    // Tangani saat user memilih folder dari file dialog browser
    async function handleFolderSelected(event) {
      const files = event.target.files;
      if (!files || files.length === 0) return;

      // Ambil nama folder dari relative path file pertama (misal: "Downloads_Lab/file.ext")
      const firstRelPath = files[0].webkitRelativePath || '';
      const folderName = firstRelPath.split('/')[0] || '';

      if (!folderName) {
        showToast('Tidak dapat mendeteksi nama folder yang dipilih.', 'error');
        return;
      }

      // Ambil sampel nama beberapa file untuk verifikasi path di backend
      const sampleFiles = [];
      for (let i = 0; i < Math.min(files.length, 5); i++) {
        sampleFiles.push(files[i].name);
      }

      showToast('Mencari lokasi folder "' + folderName + '" di komputer...', 'info');

      try {
        const response = await fetch('/api/locate-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderName: folderName, sampleFiles: sampleFiles })
        });

        const data = await response.json();
        if (data.success && data.foundPath) {
          document.getElementById('targetPathInput').value = data.foundPath;
          showToast('Folder berhasil dipilih: ' + data.foundPath, 'success');
          // Langsung pemicu scan otomatis tanpa perlu klik tombol scan lagi
          triggerScan();
        } else {
          showToast('Folder "' + folderName + '" dipilih. Silakan verifikasi di penjelajah folder.', 'info');
          openDirectoryModal(folderName);
        }
      } catch (err) {
        showToast('Gagal mencocokkan path: ' + err.message, 'error');
      }
    }

    // MODAL DIRECTORY EXPLORER
    async function openDirectoryModal(searchHint = '') {
      const inputVal = document.getElementById('targetPathInput').value.trim().replace(/^["']+|["']+$/g, '');
      const startPath = inputVal || 'C:\\\\Users\\\\Student\\\\Documents';
      document.getElementById('dirExplorerModal').classList.add('active');
      browseDirectory(startPath);
    }

    function closeDirectoryModal() {
      document.getElementById('dirExplorerModal').classList.remove('active');
    }

    async function browseDirectory(targetPath) {
      activeExploredPath = targetPath;
      document.getElementById('explorerCurrentPath').innerText = targetPath;
      const listContainer = document.getElementById('dirListContainer');
      listContainer.innerHTML = '<div class="empty-state"><span class="spinner"></span> Membaca folder...</div>';

      try {
        const res = await fetch('/api/browse-dirs?path=' + encodeURIComponent(targetPath));
        const data = await res.json();
        if (!data.success) {
          listContainer.innerHTML = '<div class="empty-state" style="color: #fb7185;">' + (data.message || 'Gagal membaca folder') + '</div>';
          return;
        }

        activeExploredPath = data.currentPath;
        document.getElementById('explorerCurrentPath').innerText = data.currentPath;

        let html = '';
        if (data.parentPath) {
          html += \`
            <div class="dir-item" onclick="browseDirectory('\${escapeJs(data.parentPath)}')">
              <div class="dir-item-name">
                <span>📁</span>
                <span>.. (Kembali ke folder atas)</span>
              </div>
              <span style="font-size: 0.78rem; color: var(--text-dim);">Naik 1 Level</span>
            </div>
          \`;
        }

        if (data.subdirs.length === 0) {
          html += '<div style="padding: 16px; text-align: center; color: var(--text-dim); font-size: 0.85rem;">Tidak ada subfolder di dalam direktori ini.</div>';
        } else {
          data.subdirs.forEach(sd => {
            html += \`
              <div class="dir-item">
                <div class="dir-item-name" onclick="browseDirectory('\${escapeJs(sd.path)}')">
                  <span>📁</span>
                  <span>\${escapeHtml(sd.name)}</span>
                </div>
                <div class="dir-item-actions">
                  <button class="btn-mini btn-secondary" onclick="browseDirectory('\${escapeJs(sd.path)}')">Buka</button>
                  <button class="btn-mini btn-mini-primary" onclick="selectSpecificDir('\${escapeJs(sd.path)}')">Pilih & Pindai</button>
                </div>
              </div>
            \`;
          });
        }

        listContainer.innerHTML = html;
      } catch (err) {
        listContainer.innerHTML = '<div class="empty-state" style="color: #fb7185;">' + err.message + '</div>';
      }
    }

    function selectSpecificDir(dirPath) {
      document.getElementById('targetPathInput').value = dirPath;
      closeDirectoryModal();
      showToast('Folder dipilih: ' + dirPath, 'success');
      triggerScan();
    }

    function selectCurrentExploredDir() {
      if (!activeExploredPath) return;
      selectSpecificDir(activeExploredPath);
    }

    function escapeJs(str) {
      return str.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
    }

    function setPresetPath(pathVal) {
      document.getElementById('targetPathInput').value = pathVal;
      showToast('Path dipilih: ' + pathVal);
      triggerScan();
    }

    function switchTab(tabId) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      event.currentTarget.classList.add('active');
      document.getElementById(tabId).classList.add('active');
    }

    function showToast(msg, type = 'info') {
      const toast = document.getElementById('toast');
      const toastMsg = document.getElementById('toastMsg');
      const toastIcon = document.getElementById('toastIcon');

      toast.className = 'toast show ' + type;
      toastMsg.innerText = msg;
      toastIcon.innerText = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';

      setTimeout(() => {
        toast.className = 'toast';
      }, 3500);
    }

    function copyToClipboard(text) {
      navigator.clipboard.writeText(text).then(() => {
        showToast('Hash SHA-256 disalin ke clipboard!', 'success');
      }).catch(() => {
        showToast('Gagal menyalin hash.', 'error');
      });
    }

    function toggleAccordion(headerEl) {
      const item = headerEl.closest('.accordion-item');
      item.classList.toggle('expanded');
    }

    // Pemicu Scan ke Backend API
    async function triggerScan() {
      let pathVal = document.getElementById('targetPathInput').value.trim();
      pathVal = pathVal.replace(/^["']+|["']+$/g, '').trim();
      document.getElementById('targetPathInput').value = pathVal;

      if (!pathVal) {
        showToast('Silakan pilih atau masukkan path folder target!', 'error');
        return;
      }

      const btnScan = document.getElementById('btnScan');
      const scanSpinner = document.getElementById('scanSpinner');
      const scanIcon = document.getElementById('scanIcon');

      btnScan.disabled = true;
      scanSpinner.style.display = 'inline-block';
      scanIcon.style.display = 'none';

      try {
        const response = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: pathVal })
        });

        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.message || 'Gagal memindai direktori.');
        }

        scanData = data.result;
        renderDashboard(scanData);
        showToast('Pemindaian selesai! Ditemukan ' + scanData.metrics.totalFiles + ' file.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btnScan.disabled = false;
        scanSpinner.style.display = 'none';
        scanIcon.style.display = 'inline-block';
      }
    }

    // Render Data Scan ke Tampilan UI
    function renderDashboard(data) {
      const m = data.metrics;

      // Update 4 Kartu Metrik
      document.getElementById('valTotalFiles').innerText = m.totalFiles;
      document.getElementById('subTotalFiles').innerText = m.totalFiles + ' file di ' + data.targetFolder;

      document.getElementById('valTotalCapacity').innerText = m.totalSizeFormatted;
      document.getElementById('subTotalCapacity').innerText = m.totalSizeDetailed;

      document.getElementById('valGiantFiles').innerText = m.giantFilesCount;

      document.getElementById('valSavings').innerText = m.potentialSavingsFormatted;
      document.getElementById('subSavings').innerText = m.potentialSavingsDetailed + ' (' + m.duplicateGroupsCount + ' grup duplikat)';

      // Update Tab Pills
      document.getElementById('pillDuplicates').innerText = m.duplicateGroupsCount;
      document.getElementById('pillGiants').innerText = m.giantFilesCount;
      document.getElementById('pillTemp').innerText = m.tempFilesCount;
      document.getElementById('pillAll').innerText = m.totalFiles;

      // Aktifkan / Nonaktifkan Tombol Bersihkan
      const canClean = (m.duplicateCopiesCount > 0 || m.tempFilesCount > 0);
      document.getElementById('btnClean').disabled = !canClean;

      // Render Tab 1: Accordion Kelompok Duplikat
      renderDuplicates(data.duplicateGroups);

      // Render Tab 2: Tabel File Raksasa
      renderGiants(data.giantFiles);

      // Render Tab 3: Tabel File Temp
      renderTempFiles(data.tempFiles);

      // Render Tab 4: Semua File
      renderAllFiles(data.allFiles);
    }

    function renderDuplicates(groups) {
      const container = document.getElementById('duplicateList');
      if (!groups || groups.length === 0) {
        container.innerHTML = \`
          <div class="empty-state">
            <div class="empty-state-icon">🎉</div>
            <p style="font-weight: 600; color: #34d399; font-size: 1.1rem;">Luar Biasa! Tidak Ditemukan File Duplikat.</p>
            <p style="margin-top: 4px;">Penyimpanan Anda bersih dari file kembar identik.</p>
          </div>
        \`;
        return;
      }

      let html = '';
      groups.forEach((g, idx) => {
        html += \`
          <div class="accordion-item \${idx < 3 ? 'expanded' : ''}">
            <div class="accordion-header" onclick="toggleAccordion(this)">
              <div class="accordion-left">
                <div class="accordion-idx">\${idx + 1}</div>
                <div class="accordion-info">
                  <div class="accordion-title">\${escapeHtml(g.representativeName)}</div>
                  <div class="accordion-meta">
                    <span>Ukuran Per File: <strong>\${g.sizeFormatted}</strong></span>
                    <span>&bull;</span>
                    <span>Total Salinan: \${g.copiesCount} File</span>
                  </div>
                </div>
              </div>
              <div class="accordion-right">
                <span class="badge-count">\${g.copiesCount} File Identik</span>
                <span class="badge-saved">Hemat \${g.redundantFormatted}</span>
                <span class="chevron">▼</span>
              </div>
            </div>
            <div class="accordion-body">
              <div class="hash-row">
                <span class="hash-label">SHA-256:</span>
                <span class="hash-code">\${g.hash}</span>
                <button class="btn-copy" onclick="copyToClipboard('\${g.hash}')">Salin Hash</button>
              </div>
              <div class="file-items">
                \${g.files.map(f => \`
                  <div class="file-item \${f.isOriginal ? 'original' : 'copy'}">
                    <div class="file-details">
                      <div class="file-name">\${escapeHtml(f.name)}</div>
                      <div class="file-path">\${escapeHtml(f.path)}</div>
                    </div>
                    <div>
                      \${f.isOriginal 
                        ? '<span class="file-tag tag-keep">🛡️ Pertahankan (Asli)</span>' 
                        : '<span class="file-tag tag-delete">🗑️ Akan Dihapus (Salinan)</span>'}
                    </div>
                  </div>
                \`).join('')}
              </div>
            </div>
          </div>
        \`;
      });

      container.innerHTML = html;
    }

    function renderGiants(giants) {
      const tbody = document.getElementById('giantTableBody');
      if (!giants || giants.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Tidak ada file yang melebihi ambang batas 3 MB (2.048 KB).</td></tr>';
        return;
      }

      let html = '';
      giants.forEach((f, idx) => {
        const mtimeFormatted = new Date(f.mtime).toLocaleString('id-ID');
        html += \`
          <tr>
            <td>\${idx + 1}</td>
            <td class="table-filename">
              <span>📄</span>
              <span>\${escapeHtml(f.name)}</span>
            </td>
            <td>
              <span class="size-badge-giant">\${f.sizeFormatted}</span>
            </td>
            <td><span class="ext-badge">\${escapeHtml(f.ext)}</span></td>
            <td style="font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; color: var(--text-dim);">
              \${escapeHtml(f.path)}
            </td>
            <td style="font-size: 0.82rem; color: var(--text-dim);">\${mtimeFormatted}</td>
          </tr>
        \`;
      });

      tbody.innerHTML = html;
    }

    function renderTempFiles(temps) {
      const tbody = document.getElementById('tempTableBody');
      if (!temps || temps.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Tidak ada file sementara (.tmp) ditemukan.</td></tr>';
        return;
      }

      let html = '';
      temps.forEach((f, idx) => {
        html += \`
          <tr>
            <td>\${idx + 1}</td>
            <td class="table-filename">\${escapeHtml(f.name)}</td>
            <td>\${f.readableSize}</td>
            <td style="font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; color: var(--text-dim);">
              \${escapeHtml(f.path)}
            </td>
            <td><span class="file-tag tag-delete">Siap Dibersihkan</span></td>
          </tr>
        \`;
      });

      tbody.innerHTML = html;
    }

    function renderAllFiles(files) {
      const tbody = document.getElementById('allFilesTableBody');
      if (!files || files.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Belum ada file.</td></tr>';
        return;
      }

      let html = '';
      const displayFiles = files.slice(0, 100);
      displayFiles.forEach((f, idx) => {
        html += \`
          <tr>
            <td>\${idx + 1}</td>
            <td class="table-filename">\${escapeHtml(f.name)}</td>
            <td>\${f.readableSize}</td>
            <td style="font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; color: var(--primary);">
              \${f.hash.substring(0, 16)}...
            </td>
            <td style="font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; color: var(--text-dim);">
              \${escapeHtml(f.path)}
            </td>
          </tr>
        \`;
      });

      if (files.length > 100) {
        html += \`<tr><td colspan="5" style="text-align: center; color: var(--text-dim); font-style: italic;">...dan \${files.length - 100} file lainnya...</td></tr>\`;
      }

      tbody.innerHTML = html;
    }

    // Modal Pembersihan
    function openCleanModal() {
      if (!scanData) return;

      const toDelete = [];
      let freedBytes = 0;

      scanData.duplicateGroups.forEach(g => {
        g.files.forEach(f => {
          if (!f.isOriginal && f.canDelete) {
            toDelete.push({ name: f.name, path: f.path, size: f.size, readable: f.readableSize });
            freedBytes += f.size;
          }
        });
      });

      scanData.tempFiles.forEach(tf => {
        if (!toDelete.some(item => item.path === tf.path)) {
          toDelete.push({ name: tf.name, path: tf.path, size: tf.size, readable: tf.readableSize });
          freedBytes += tf.size;
        }
      });

      document.getElementById('modalFilesCount').innerText = toDelete.length + ' File';
      document.getElementById('modalSavedBytes').innerText = (freedBytes / (1024 * 1024)).toFixed(2) + ' MB';

      const listContainer = document.getElementById('modalFilesList');
      listContainer.innerHTML = toDelete.map(item => \`
        <div class="clean-file-list-item">
          <span>\${escapeHtml(item.name)}</span>
          <span style="color: #fb7185;">\${item.readable}</span>
        </div>
      \`).join('');

      document.getElementById('cleanModal').classList.add('active');
    }

    function closeCleanModal() {
      document.getElementById('cleanModal').classList.remove('active');
    }

    async function executeClean() {
      const pathVal = document.getElementById('targetPathInput').value.trim().replace(/^["']+|["']+$/g, '');
      const btnConfirm = document.getElementById('btnConfirmClean');
      const cleanSpinner = document.getElementById('cleanSpinner');
      const cleanIcon = document.getElementById('cleanIcon');

      btnConfirm.disabled = true;
      cleanSpinner.style.display = 'inline-block';
      cleanIcon.style.display = 'none';

      try {
        const response = await fetch('/api/clean', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: pathVal })
        });

        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.message || 'Gagal mengeksekusi pembersihan.');
        }

        closeCleanModal();
        scanData = data.updatedScan;
        renderDashboard(scanData);
        showToast('Pembersihan berhasil! ' + data.deletedCount + ' file dihapus, membebaskan ' + data.freedFormatted + '.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btnConfirm.disabled = false;
        cleanSpinner.style.display = 'none';
        cleanIcon.style.display = 'inline-block';
      }
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    // Pemindaian otomatis saat pertama kali dibuka di browser
    window.addEventListener('DOMContentLoaded', () => {
      triggerScan();
    });
  </script>
</body>
</html>`;
}

// Handler request server HTTP
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost:3000'}`);

  // Helper kirim JSON
  const sendJson = (statusCode, data) => {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(data));
  };

  // Helper baca body request
  const readJsonBody = () => {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
        if (body.length > 10 * 1024 * 1024) {
          reject(new Error('Payload terlalu besar'));
        }
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (e) {
          reject(new Error('Format JSON tidak valid'));
        }
      });
      req.on('error', err => reject(err));
    });
  };

  try {
    // GET / : Dashboard Web UI
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getDashboardHtml());
      return;
    }

    // GET /api/default-path : Mengembalikan path default
    if (req.method === 'GET' && url.pathname === '/api/default-path') {
      sendJson(200, { defaultPath: DEFAULT_TARGET_DIR });
      return;
    }

    // POST /api/locate-folder : Mencocokkan nama folder yang diupload dari browser ke path absolut OS
    if (req.method === 'POST' && url.pathname === '/api/locate-folder') {
      const body = await readJsonBody();
      const folderName = body.folderName || '';
      const sampleFiles = body.sampleFiles || [];

      const found = locateFolderOnSystem(folderName, sampleFiles);
      if (found) {
        sendJson(200, { success: true, foundPath: found });
      } else {
        sendJson(200, { success: false, message: 'Folder tidak ditemukan otomatis di path umum.' });
      }
      return;
    }

    // GET /api/browse-dirs : Menjelajahi subfolder
    if (req.method === 'GET' && url.pathname === '/api/browse-dirs') {
      const rawPath = url.searchParams.get('path') || path.join(os.homedir(), 'Documents');
      const sanitized = sanitizePath(rawPath);
      const targetDir = path.resolve(sanitized);

      if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        sendJson(400, { success: false, message: `Folder tidak valid: ${targetDir}` });
        return;
      }

      const entries = fs.readdirSync(targetDir, { withFileTypes: true });
      const subdirs = entries
        .filter(e => e.isDirectory())
        .map(e => ({
          name: e.name,
          path: path.join(targetDir, e.name)
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const parent = path.dirname(targetDir);
      const parentPath = parent !== targetDir ? parent : null;

      sendJson(200, {
        success: true,
        currentPath: targetDir,
        parentPath: parentPath,
        subdirs: subdirs
      });
      return;
    }

    // POST /api/scan : Memindai folder target
    if (req.method === 'POST' && url.pathname === '/api/scan') {
      const body = await readJsonBody();
      const targetDir = sanitizePath(body.path) || DEFAULT_TARGET_DIR;

      console.log(`[SCAN] Memulai pemindaian: ${targetDir}`);
      const scanResult = await performScan(targetDir);
      console.log(`[SCAN] Selesai: ${scanResult.metrics.totalFiles} file, ${scanResult.metrics.duplicateGroupsCount} grup duplikat.`);

      sendJson(200, { success: true, result: scanResult });
      return;
    }

    // POST /api/clean : Pembersihan in-place
    if (req.method === 'POST' && url.pathname === '/api/clean') {
      const body = await readJsonBody();
      const targetDir = sanitizePath(body.path) || DEFAULT_TARGET_DIR;

      console.log(`[CLEAN] Mengeksekusi pembersihan in-place pada: ${targetDir}`);
      const cleanResult = await performCleaning(targetDir);
      console.log(`[CLEAN] Berhasil menghapus ${cleanResult.deletedCount} file.`);

      sendJson(200, cleanResult);
      return;
    }

    // 404 Not Found
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
  } catch (err) {
    console.error('[SERVER ERROR]', err);
    sendJson(500, { success: false, message: err.message || 'Terjadi kesalahan pada server.' });
  }
});

// Menjalankan server dan membuka browser otomatis
server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log('=======================================================');
  console.log(`🚀 Storage Audit & Cleaner Server Berjalan di: ${url}`);
  console.log(`📁 Target Direktori Default: ${DEFAULT_TARGET_DIR}`);
  console.log(`✨ Menggunakan runtime murni Node.js bawaan (http, fs, path, crypto)`);
  console.log('=======================================================');

  // Otomatis buka browser default di Windows
  const openCmd = process.platform === 'win32' ? `start ${url}` :
                  process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
  exec(openCmd, (err) => {
    if (err) {
      console.log(`Buka browser Anda secara manual di: ${url}`);
    }
  });
});
