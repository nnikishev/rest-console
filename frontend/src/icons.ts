import { createElement, Menu, Server, Users, UserPlus, Pencil, Trash2, Upload, File, Download, X, Plus, Activity, Folder, ArrowUp, ArrowRight, HardDrive, ChevronRight, FolderOpen, Zap, LogOut, RefreshCw, ShieldCheck, Eye, EyeOff, Save, Plug, Unplug } from 'lucide';
const icons = { folder: Folder, 'arrow-up': ArrowUp, 'arrow-right': ArrowRight, 'hard-drive': HardDrive, 'chevron-right': ChevronRight, upload: Upload, file: File, menu: Menu, server: Server, users: Users, 'user-plus': UserPlus, pencil: Pencil, 'trash-2': Trash2, download: Download, x: X, plus: Plus, activity: Activity, 'folder-open': FolderOpen, zap: Zap, 'log-out': LogOut, 'refresh-cw': RefreshCw, 'shield-check': ShieldCheck, eye: Eye, 'eye-off': EyeOff, save: Save, plug: Plug, unplug: Unplug };
export function icon(name: keyof typeof icons) {
  const svg = createElement(icons[name]); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('ui-icon'); return svg;
}
export function decorateIcons(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-lucide]').forEach(element => {
    const name = element.dataset.lucide as keyof typeof icons;
    if (icons[name]) element.replaceWith(icon(name));
  });
}
export function actionIcon(button: HTMLElement, name: keyof typeof icons, label?: string) {
  button.replaceChildren(icon(name));
  if (label) button.append(document.createTextNode(label));
}
