import React, { useEffect, useState } from 'react';
import ConnManager from './ConnManager';
import './styles.css';

const connManager = ConnManager.getInstance();

interface ImageFilesPanelProps {
  refreshTrigger?: number;
  onDownloadActiveChange?: (active: boolean) => void;
}

interface FileEntry {
  name: string;
  size: number;
  isDir: boolean;
}

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.bmp'];

function isImageFile(name: string): boolean {
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export default function ImageFilesPanel({ refreshTrigger, onDownloadActiveChange }: ImageFilesPanelProps) {
  const [fs, setFs] = useState('sd');
  const [path, setPath] = useState('images');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [downloadingFile, setDownloadingFile] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [deletingFile, setDeletingFile] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ name: string; url: string; size: number } | null>(null);
  const [lastError, setLastError] = useState('');

  const fetchFiles = async (fsName = fs, folderPath = path) => {
    if (!connManager.getConnector().isConnected()) return;
    setIsLoading(true);
    setLastError('');
    try {
      const resp = await connManager.getConnector().sendRICRESTMsg(
        `filelist/${fsName}/${folderPath}`, {}
      );
      const fileList = typeof resp === 'string' ? JSON.parse(resp) : resp;
      const r = fileList as any;
      if (r?.rslt && r.rslt !== 'ok') {
        setEntries([]);
        setLastError(fsName === 'sd' ? 'Folder not found (is an SD card inserted?)' : 'Folder not found');
      } else {
        const files: FileEntry[] = (r.files || []).map((f: any) => ({
          name: f.name,
          size: f.size ?? 0,
          isDir: (f.isDir ?? 0) == 1,
        }));
        // Folders first, then newest files first (timestamped names sort naturally)
        files.sort((a, b) => (a.isDir !== b.isDir) ? (a.isDir ? -1 : 1) : b.name.localeCompare(a.name));
        setEntries(files);
      }
    } catch (e) {
      console.warn('Failed to get image file list', e);
      setEntries([]);
      setLastError('Failed to get file list');
    }
    setIsLoading(false);
  };

  useEffect(() => {
    fetchFiles();
  }, [refreshTrigger, fs, path]);

  // Revoke the preview blob URL when replaced/removed
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const enterFolder = (name: string) => {
    setPreview(null);
    setPath(path ? `${path}/${name}` : name);
  };

  const pathSegments = path.split('/').filter((s) => s.length > 0);

  const navigateToSegment = (index: number) => {
    setPreview(null);
    // index -1 = filesystem root
    setPath(pathSegments.slice(0, index + 1).join('/'));
  };

  const downloadFileData = async (file: FileEntry): Promise<Uint8Array | null> => {
    setDownloadingFile(file.name);
    setDownloadProgress(0);
    setLastError('');
    onDownloadActiveChange?.(true);
    try {
      const filePath = path ? `${fs}/${path}/${file.name}` : `${fs}/${file.name}`;
      const result = await connManager.getConnector().fsGetContents(
        filePath,
        'fs',
        (received: number, total: number) => {
          if (total > 0) setDownloadProgress(Math.round((received / total) * 100));
        }
      );
      if (result.downloadedOk && result.fileData) {
        return result.fileData;
      }
      setLastError(`Failed to download ${file.name}`);
      return null;
    } catch (e) {
      console.warn('Download failed', e);
      setLastError(`Download error: ${file.name}`);
      return null;
    } finally {
      setDownloadingFile(null);
      setDownloadProgress(0);
      onDownloadActiveChange?.(false);
    }
  };

  const saveBlob = (data: Uint8Array, name: string) => {
    const copy = new Uint8Array(data);
    const blob = new Blob([copy.buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handlePreview = async (file: FileEntry) => {
    const data = await downloadFileData(file);
    if (!data) return;
    const copy = new Uint8Array(data);
    const blob = new Blob([copy.buffer as ArrayBuffer], { type: 'image/jpeg' });
    setPreview({ name: file.name, url: URL.createObjectURL(blob), size: file.size });
  };

  const handleDownload = async (file: FileEntry) => {
    const data = await downloadFileData(file);
    if (data) saveBlob(data, file.name);
  };

  const handleDelete = async (file: FileEntry) => {
    const confirmed = window.confirm(`Delete ${file.name} (${formatBytes(file.size)})?`);
    if (!confirmed) return;
    setDeletingFile(file.name);
    setLastError('');
    try {
      const filePath = path ? `${fs}/${path}/${file.name}` : `${fs}/${file.name}`;
      const resp = await connManager.getConnector().sendRICRESTMsg(`filedelete/${filePath}`, {});
      const r = resp as any;
      if (r?.rslt === 'ok') {
        if (preview?.name === file.name) setPreview(null);
        await fetchFiles();
      } else {
        setLastError(`Failed to delete ${file.name}`);
      }
    } catch (e) {
      console.warn('Delete failed', e);
      setLastError(`Delete error: ${file.name}`);
    }
    setDeletingFile(null);
  };

  const busy = downloadingFile !== null || deletingFile !== null;

  return (
    <div className="info-box log-files-panel image-files-panel">
      <div className="log-files-header">
        <h3>Images</h3>
        <select
          className="camera-select"
          value={fs}
          onChange={(e) => { setPreview(null); setFs(e.target.value); setPath('images'); }}
          title="Filesystem"
        >
          <option value="sd">SD card</option>
          <option value="local">Local</option>
        </select>
        <button
          className="log-files-refresh-button"
          onClick={() => fetchFiles()}
          disabled={isLoading}
          title="Refresh file list"
        >
          ↻
        </button>
      </div>

      <div className="image-files-breadcrumb">
        <span className="image-files-crumb" onClick={() => navigateToSegment(-1)}>{fs}</span>
        {pathSegments.map((seg, i) => (
          <span key={i}>
            {' / '}
            <span className="image-files-crumb" onClick={() => navigateToSegment(i)}>{seg}</span>
          </span>
        ))}
      </div>

      {isLoading ? (
        <div className="log-files-loading">Loading...</div>
      ) : entries.length === 0 ? (
        <div className="log-files-empty">{lastError ? '' : 'No files found'}</div>
      ) : (
        <div className="log-files-list">
          {entries.map((file) => {
            const isDownloading = downloadingFile === file.name;
            if (file.isDir) {
              return (
                <div key={file.name} className="log-file-item image-files-folder" onClick={() => enterFolder(file.name)}>
                  <div className="log-file-info">
                    <div className="log-file-name" title={file.name}>📁 {file.name}</div>
                  </div>
                </div>
              );
            }
            return (
              <div key={file.name} className="log-file-item">
                <div className="log-file-info">
                  <div className="log-file-name" title={file.name}>{file.name}</div>
                  <div className="log-file-size">{formatBytes(file.size)}</div>
                </div>
                <div className="log-file-actions">
                  {isImageFile(file.name) && (
                    <button
                      className="log-file-download-button"
                      onClick={() => handlePreview(file)}
                      disabled={busy}
                      title={`Preview ${file.name}`}
                    >
                      {isDownloading ? `${downloadProgress}%` : '👁'}
                    </button>
                  )}
                  <button
                    className="log-file-download-button"
                    onClick={() => handleDownload(file)}
                    disabled={busy}
                    title={`Download ${file.name}`}
                  >
                    {isDownloading ? `${downloadProgress}%` : '⬇'}
                  </button>
                  <button
                    className="log-file-delete-button"
                    onClick={() => handleDelete(file)}
                    disabled={busy}
                    title={`Delete ${file.name}`}
                  >
                    {deletingFile === file.name ? '...' : '🗑'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {preview && (
        <div className="image-preview">
          <div className="image-preview-header">
            <span className="log-file-name">{preview.name} ({formatBytes(preview.size)})</span>
            <button className="log-files-refresh-button" onClick={() => setPreview(null)} title="Close preview">✕</button>
          </div>
          <img className="image-preview-img" src={preview.url} alt={preview.name} />
        </div>
      )}

      {lastError && (
        <div className="logging-error">{lastError}</div>
      )}
    </div>
  );
}
