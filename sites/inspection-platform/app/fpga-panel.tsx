'use client';

import {Plug, FolderOpen, RefreshCw} from 'lucide-react';

export type DeviceStatus = {
  connection: 'disconnected' | 'searching' | 'connected' | 'receiving' | 'error';
  handshake?: boolean;
  stale?: boolean;
  port?: string;
  build?: string;
  message?: string;
  progress?: number;
  archivePath?: string;
  sync?: 'idle' | 'pending' | 'synced' | 'error';
  lastCaptureId?: string;
  updatedAt?: string | null;
};

export function deviceConnected(status: DeviceStatus | null) {
  return !!status?.handshake && !status.stale && ['connected', 'receiving'].includes(status.connection);
}

export function deviceTitle(status: DeviceStatus | null) {
  if (!status || status.stale) return '接收服务未运行';
  if (status.connection === 'receiving' && status.handshake) return '正在接收 CNN 图像';
  if (deviceConnected(status)) return status.sync === 'error' ? '已连接 · 网站同步待重试' : 'CNN 已连接';
  if (status.connection === 'searching') return status.message?.startsWith('原版R2')?'R2 接收器已启动':'等待首次回传';
  if (status.connection === 'error') return '连接需要检查';
  return '等待设备连接';
}

export default function FpgaPanel({status, latest, onView,autoShow,onAutoShow}: {
  status: DeviceStatus | null;
  latest?: {id: string; partId: string};
  onView: () => void;
  autoShow: boolean;
  onAutoShow: (enabled:boolean) => void;
}) {
  const connected = deviceConnected(status);
  const progress = Math.max(0, Math.min(100, status?.progress || 0));
  return <section className="fpga-live" aria-label="FPGA 自动回传状态" aria-live="polite">
    <div className="fpga-live-heading">
      <Plug size={21}/>
      <div><b>{deviceTitle(status)}</b><p>{status?.stale || !status
        ? '自动回传需单独启动接收桥，操作见 README；也可直接导入图片。'
        : status.message || '连接底板 UART，并在板子上进入 CNN 模式。'}</p></div>
      <span className={`badge ${connected ? 'green' : 'muted'}`}>{status?.port || (status?.message?.startsWith('原版R2')?'原版 R2':'等待串口')}</span>
    </div>
    {status?.connection === 'receiving' && <div className="fpga-transfer">
      <progress max={100} value={progress}/><span>{progress.toFixed(0)}%</span>
    </div>}
    <div className="fpga-live-details">
      <span><FolderOpen size={14}/>自动回传网站 · 桌面保留备份</span>
      <label className="auto-show-control"><input type="checkbox" checked={autoShow} onChange={event=>onAutoShow(event.target.checked)}/>新回传自动显示</label>
      {latest && <button className="text-button" onClick={onView}>
        <RefreshCw size={14}/>查看最新回传
      </button>}
    </div>
    {status?.sync === 'pending' && <p className="fpga-sync">图片已接收，正在加载到工作台。</p>}
    {status?.sync === 'synced' && <p className="fpga-sync success">最新结果已回传网站。</p>}
    {status?.sync === 'error' && <p className="fpga-sync">本机归档保留，网站导入会自动重试。</p>}
  </section>;
}
