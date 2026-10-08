"""
Storage Audit & Cleaner - Python Edition
Menggunakan library standar bawaan: http.server, os, hashlib, json, urllib, webbrowser
Tanpa memerlukan pip install dependensi eksternal apa pun.
"""

import os
import sys
import json
import hashlib
from http.server import HTTPServer, BaseHTTPRequestHandler
import urllib.parse
import webbrowser

PORT = 3000
DEFAULT_TARGET_DIR = r"C:\Users\Student\Documents\Downloads_Lab"
GIANT_FILE_THRESHOLD_BYTES = 2048 * 1024

current_scan_data = None

def sanitize_path(p):
    if not p:
        return ""
    return p.strip().strip('"').strip("'").strip()

def format_mb(size_bytes):
    return f"{size_bytes / (1024 * 1024):.2f} MB"

def format_kb(size_bytes):
    return f"{round(size_bytes / 1024):,} KB".replace(",", ".")

def format_readable(size_bytes):
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes / (1024 * 1024):.2f} MB"

def get_file_sha256(filepath):
    sha = hashlib.sha256()
    with open(filepath, 'rb') as f:
        while chunk := f.read(65536):
            sha.update(chunk)
    return sha.hexdigest()

def is_likely_copy_name(filename):
    lower = filename.lower()
    indicators = [' - copy', ' - salinan', '_copy', '_backup', 'backup_', ' (1)', ' (2)', ' (3)', '_v2', '_edit', 'edit2', '_fix', '_final']
    return any(ind in lower for ind in indicators)

def locate_folder(folder_name, sample_files=None):
    home = os.path.expanduser("~")
    candidate_bases = [
        os.path.join(home, "Desktop"),
        os.path.join(home, "Documents"),
        os.path.join(home, "Downloads"),
        home,
        os.getcwd(),
        "C:\\"
    ]
    for base in candidate_bases:
        cand = os.path.join(base, folder_name)
        if os.path.isdir(cand):
            if sample_files:
                if any(os.path.exists(os.path.join(cand, sf)) for sf in sample_files):
                    return cand
            else:
                return cand
    for base in [os.path.join(home, "Documents"), os.path.join(home, "Desktop")]:
        if os.path.isdir(base):
            for sub in os.listdir(base):
                sub_path = os.path.join(base, sub, folder_name)
                if os.path.isdir(sub_path):
                    return sub_path
    return None

def perform_scan(target_folder):
    global current_scan_data
    normalized = os.path.abspath(sanitize_path(target_folder))
    if not os.path.exists(normalized) or not os.path.isdir(normalized):
        raise ValueError(f"Direktori tidak valid atau tidak ditemukan: {normalized}")

    raw_files = []
    for root, _, files in os.walk(normalized):
        for fname in files:
            full_path = os.path.join(root, fname)
            try:
                st = os.stat(full_path)
                _, ext = os.path.splitext(fname)
                raw_files.append({
                    "name": fname,
                    "path": full_path,
                    "size": st.st_size,
                    "mtime": st.st_mtime,
                    "ext": ext.lower()
                })
            except Exception as e:
                print(f"[WARN] Akses file gagal: {full_path} - {e}")

    processed_files = []
    for rf in raw_files:
        try:
            fhash = get_file_sha256(rf["path"])
            is_giant = rf["size"] >= GIANT_FILE_THRESHOLD_BYTES
            is_temp = rf["ext"] == ".tmp" or rf["name"].startswith("~$") or rf["name"].endswith(".tmp")

            processed_files.append({
                "name": rf["name"],
                "path": rf["path"],
                "relPath": os.path.relpath(rf["path"], normalized),
                "size": rf["size"],
                "sizeMB": format_mb(rf["size"]),
                "sizeKB": format_kb(rf["size"]),
                "sizeFormatted": f"{format_mb(rf['size'])} ({format_kb(rf['size'])})",
                "readableSize": format_readable(rf["size"]),
                "hash": fhash,
                "mtime": rf["mtime"],
                "ext": rf["ext"] or "tanpa ekstensi",
                "isGiant": is_giant,
                "isTemp": is_temp
            })
        except Exception as e:
            print(f"[WARN] Hash gagal: {rf['path']} - {e}")

    hash_map = {}
    for pf in processed_files:
        hash_map.setdefault(pf["hash"], []).append(pf)

    duplicate_groups = []
    total_redundant = 0
    total_copies_count = 0

    for fhash, files in hash_map.items():
        if len(files) > 1:
            def sort_key(f):
                copy_flag = 1 if is_likely_copy_name(f["name"]) else 0
                return (copy_flag, len(f["name"]), f["mtime"])

            files.sort(key=sort_key)
            tagged_files = []
            for idx, f in enumerate(files):
                item = dict(f)
                item["isOriginal"] = (idx == 0)
                item["canDelete"] = (idx > 0)
                tagged_files.append(item)

            one_size = tagged_files[0]["size"]
            count = len(tagged_files)
            redundant = one_size * (count - 1)
            total_redundant += redundant
            total_copies_count += (count - 1)

            duplicate_groups.append({
                "groupId": fhash[:12],
                "hash": fhash,
                "fileSize": one_size,
                "sizeFormatted": f"{format_mb(one_size)} ({format_kb(one_size)})",
                "readableSize": format_readable(one_size),
                "copiesCount": count,
                "redundantBytes": redundant,
                "redundantFormatted": format_readable(redundant),
                "representativeName": tagged_files[0]["name"],
                "files": tagged_files
            })

    duplicate_groups.sort(key=lambda g: g["redundantBytes"], reverse=True)
    giant_files = sorted([f for f in processed_files if f["isGiant"]], key=lambda x: x["size"], reverse=True)
    temp_files = [f for f in processed_files if f["isTemp"]]
    temp_bytes = sum(f["size"] for f in temp_files)

    clean_duplicate_paths = set()
    for g in duplicate_groups:
        for f in g["files"]:
            if not f["isOriginal"]:
                clean_duplicate_paths.add(f["path"])

    temp_non_dup_bytes = sum(tf["size"] for tf in temp_files if tf["path"] not in clean_duplicate_paths)
    total_savings = total_redundant + temp_non_dup_bytes
    total_size = sum(f["size"] for f in processed_files)

    result = {
        "targetFolder": normalized,
        "metrics": {
            "totalFiles": len(processed_files),
            "totalSizeBytes": total_size,
            "totalSizeFormatted": format_readable(total_size),
            "totalSizeDetailed": f"{format_mb(total_size)} ({format_kb(total_size)})",
            "duplicateGroupsCount": len(duplicate_groups),
            "duplicateCopiesCount": total_copies_count,
            "giantFilesCount": len(giant_files),
            "giantThresholdBytes": GIANT_FILE_THRESHOLD_BYTES,
            "giantThresholdFormatted": "3 MB (2.048 KB)",
            "tempFilesCount": len(temp_files),
            "tempFilesBytes": temp_bytes,
            "potentialSavingsBytes": total_savings,
            "potentialSavingsFormatted": format_readable(total_savings),
            "potentialSavingsDetailed": f"{format_mb(total_savings)} ({format_kb(total_savings)})"
        },
        "duplicateGroups": duplicate_groups,
        "giantFiles": giant_files,
        "tempFiles": temp_files,
        "allFiles": processed_files
    }
    current_scan_data = result
    return result

def perform_clean(target_folder):
    global current_scan_data
    normalized = os.path.abspath(sanitize_path(target_folder))
    if not current_scan_data or current_scan_data["targetFolder"] != normalized:
        perform_scan(target_folder)

    to_delete = []
    for g in current_scan_data["duplicateGroups"]:
        for f in g["files"]:
            if not f["isOriginal"] and f["canDelete"]:
                to_delete.append(f)

    for tf in current_scan_data["tempFiles"]:
        if not any(item["path"] == tf["path"] for item in to_delete):
            to_delete.append(tf)

    deleted_count = 0
    freed_bytes = 0
    errors = []

    for item in to_delete:
        try:
            if os.path.exists(item["path"]):
                os.remove(item["path"])
                deleted_count += 1
                freed_bytes += item["size"]
        except Exception as e:
            errors.append({"path": item["path"], "error": str(e)})

    updated_scan = perform_scan(target_folder)
    return {
        "success": True,
        "deletedCount": deleted_count,
        "freedBytes": freed_bytes,
        "freedFormatted": format_readable(freed_bytes),
        "errors": errors,
        "updatedScan": updated_scan
    }

class RequestHandler(BaseHTTPRequestHandler):
    def _send_json(self, status, payload):
        data = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/':
            js_file = os.path.join(os.path.dirname(__file__), 'storage_audit.js')
            with open(js_file, 'r', encoding='utf-8') as f:
                content = f.read()
                start_tag = 'function getDashboardHtml() {\n  return `'
                end_tag = '`;\n}'
                html = content.split(start_tag)[1].split(end_tag)[0]
                html = html.replace('\\`', '`').replace('\\${', '${')
            
            data = html.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif parsed.path == '/api/default-path':
            self._send_json(200, {"defaultPath": DEFAULT_TARGET_DIR})
        elif parsed.path == '/api/browse-dirs':
            query = urllib.parse.parse_qs(parsed.query)
            target = query.get('path', [os.path.join(os.path.expanduser('~'), 'Documents')])[0]
            norm = os.path.abspath(sanitize_path(target))
            if not os.path.isdir(norm):
                self._send_json(400, {"success": False, "message": "Invalid directory"})
                return
            subdirs = []
            for item in sorted(os.listdir(norm)):
                subpath = os.path.join(norm, item)
                if os.path.isdir(subpath):
                    subdirs.append({"name": item, "path": subpath})
            parent = os.path.dirname(norm)
            self._send_json(200, {
                "success": True,
                "currentPath": norm,
                "parentPath": parent if parent != norm else None,
                "subdirs": subdirs
            })
        else:
            self.send_error(404, "File Not Found")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        content_len = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_len).decode('utf-8') if content_len > 0 else '{}'
        try:
            req_data = json.loads(body)
        except Exception:
            req_data = {}

        target = sanitize_path(req_data.get('path', DEFAULT_TARGET_DIR))

        try:
            if parsed.path == '/api/scan':
                res = perform_scan(target)
                self._send_json(200, {"success": True, "result": res})
            elif parsed.path == '/api/clean':
                res = perform_clean(target)
                self._send_json(200, res)
            elif parsed.path == '/api/locate-folder':
                fname = req_data.get('folderName', '')
                sfiles = req_data.get('sampleFiles', [])
                found = locate_folder(fname, sfiles)
                if found:
                    self._send_json(200, {"success": True, "foundPath": found})
                else:
                    self._send_json(200, {"success": False})
            else:
                self.send_error(404, "Endpoint not found")
        except Exception as e:
            self._send_json(500, {"success": False, "message": str(e)})

def run():
    server = HTTPServer(('localhost', PORT), RequestHandler)
    url = f"http://localhost:{PORT}"
    print("=" * 55)
    print(f"🚀 Storage Audit & Cleaner (Python) Berjalan di: {url}")
    print(f"📁 Target Direktori Default: {DEFAULT_TARGET_DIR}")
    print("=" * 55)
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass

if __name__ == '__main__':
    run()
