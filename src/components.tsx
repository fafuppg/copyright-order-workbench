import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  X,
  Check,
  LoaderCircle,
  FileSearch,
  ZoomIn,
  ZoomOut,
  ImageOff,
} from "lucide-react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TextStyleKit } from "@tiptap/extension-text-style";
import TextAlign from "@tiptap/extension-text-align";
import { type Item } from "./api";

export function Modal({
  title,
  children,
  onClose,
  wide = false,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null),
    closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prior = document.activeElement as HTMLElement;
    box.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) closeRef.current();
      if (e.key === "Tab" && box.current) {
        const nodes = Array.from(
          box.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select,textarea,a[href],[tabindex="0"],[contenteditable="true"]',
          ),
        );
        const first = nodes[0],
          last = nodes.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      prior?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop">
      <div
        className={"modal " + (wide ? "wide " : "") + className}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={box}
        tabIndex={-1}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
export function Busy({ label = "正在处理" }: { label?: string }) {
  return (
    <span className="busy">
      <LoaderCircle className="spin" size={16} />
      {label}
    </span>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <FileSearch size={36} strokeWidth={1} />
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
export function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={"field " + (wide ? "full" : "")}>
      <span>{label}</span>
      {children}
    </label>
  );
}
export function Status({ task }: { task: Item }) {
  return (
    <span className={"status " + (task.completed ? "done" : "pending")}>
      <i />
      {task.cancelledAt
        ? "已撤销"
        : task.inRework
          ? "返工"
          : task.completed
            ? "已完成"
            : "未完成"}
    </span>
  );
}
export function InlineCell({
  value,
  onSave,
  disabled = false,
  multiline = false,
  type = "text",
  placeholder = "—",
}: {
  value: any;
  onSave: (value: any) => Promise<void>;
  disabled?: boolean;
  multiline?: boolean;
  type?: string;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(String(value ?? "")),
    [busy, setBusy] = useState(false),
    [err, setErr] = useState(""),
    [saved, setSaved] = useState(false);
  const locking = useRef(false),
    cancelled = useRef(false),
    input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) setDraft(String(value ?? ""));
  }, [value, editing]);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);
  async function commit() {
    if (locking.current || cancelled.current) return;
    if (draft === String(value ?? "")) {
      setEditing(false);
      return;
    }
    locking.current = true;
    setBusy(true);
    setErr("");
    try {
      await onSave(draft);
      setEditing(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      locking.current = false;
      setBusy(false);
    }
  }
  const props = {
    ref: input,
    value: draft,
    disabled: busy,
    onChange: (e: any) => setDraft(e.target.value),
    onBlur: () => {
      if (!err) void commit();
    },
    onKeyDown: (e: any) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelled.current = true;
        setEditing(false);
        setErr("");
      }
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        void commit();
      }
    },
  };
  if (disabled) return <span>{value || placeholder}</span>;
  return (
    <div
      className={"editable " + (saved ? "just-saved" : "")}
      onDoubleClick={() => {
        cancelled.current = false;
        setEditing(true);
      }}
    >
      {editing ? (
        <div className="cell-editor">
          {multiline ? (
            <textarea {...props} rows={3} />
          ) : (
            <input {...props} type={type} />
          )}
          {busy ? (
            <Busy label="" />
          ) : err ? (
            <>
              <small className="error">{err}</small>
              <button onClick={() => void commit()}>重试保存</button>
            </>
          ) : null}
        </div>
      ) : (
        <span
          tabIndex={0}
          title={(value ? String(value) + "\n" : "") + "双击修改；也可按回车"}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              cancelled.current = false;
              setEditing(true);
            }
          }}
          className={!value ? "muted" : ""}
        >
          {value || placeholder}
          {saved && <Check size={12} />}
        </span>
      )}
    </div>
  );
}
export function RichEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const editor = useEditor({
    shouldRerenderOnTransaction: true,
    extensions: [
      StarterKit,
      TextStyleKit,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
    ],
    content: value,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    editorProps: {
      attributes: { "aria-label": "邮件正文编辑器", class: "mail-document" },
    },
  });
  useEffect(() => {
    if (editor && value !== editor.getHTML())
      editor.commands.setContent(value, { emitUpdate: false });
  }, [value, editor]);
  if (!editor) return <Busy />;
  const button = (label: string, command: () => void, active = false) => (
    <button type="button" className={active ? "active" : ""} onClick={command}>
      {label}
    </button>
  );
  return (
    <div className="rich-editor">
      <div className="editor-toolbar" role="toolbar" aria-label="正文格式">
        <select
          aria-label="字体"
          onChange={(e) =>
            editor.chain().focus().setFontFamily(e.target.value).run()
          }
          value={editor.getAttributes("textStyle").fontFamily || "Arial"}
        >
          <option value="Arial">默认字体</option>
          <option value="Microsoft YaHei">微软雅黑</option>
          <option value="SimSun">宋体</option>
          <option value="KaiTi">楷体</option>
        </select>
        <select
          aria-label="字号"
          value={editor.getAttributes("textStyle").fontSize || "14px"}
          onChange={(e) =>
            editor.chain().focus().setFontSize(e.target.value).run()
          }
        >
          {["12", "14", "16", "18", "20", "24", "28", "32"].map((n) => (
            <option key={n} value={n + "px"}>
              {n}px
            </option>
          ))}
        </select>
        {button(
          "加粗",
          () => editor.chain().focus().toggleBold().run(),
          editor.isActive("bold"),
        )}
        {button(
          "斜体",
          () => editor.chain().focus().toggleItalic().run(),
          editor.isActive("italic"),
        )}
        {button(
          "下划线",
          () => editor.chain().focus().toggleUnderline().run(),
          editor.isActive("underline"),
        )}
        <label className="color-control">
          字色
          <input
            type="color"
            aria-label="文字颜色"
            onInput={(e) =>
              editor
                .chain()
                .focus()
                .setColor((e.target as HTMLInputElement).value)
                .run()
            }
          />
        </label>
        {button(
          "列表",
          () => editor.chain().focus().toggleBulletList().run(),
          editor.isActive("bulletList"),
        )}
        {button(
          "编号",
          () => editor.chain().focus().toggleOrderedList().run(),
          editor.isActive("orderedList"),
        )}
        <select
          aria-label="对齐"
          onChange={(e) =>
            editor.chain().focus().setTextAlign(e.target.value).run()
          }
        >
          <option value="left">左对齐</option>
          <option value="center">居中</option>
          <option value="right">右对齐</option>
        </select>
        {button("链接", () => {
          const url = window.prompt(
            "链接地址（https://…）",
            editor.getAttributes("link").href || "https://",
          );
          if (url && /^https?:\/\//.test(url))
            editor.chain().focus().setLink({ href: url }).run();
        })}
        {button("清除格式", () =>
          editor.chain().focus().unsetAllMarks().clearNodes().run(),
        )}
        {button("撤销", () => editor.chain().focus().undo().run())}
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
export function MailPreview({ html }: { html: string }) {
  return (
    <iframe
      className="mail-preview"
      title="邮件正文预览"
      sandbox=""
      srcDoc={
        '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>body{font:14px/1.8 Arial,\"Microsoft YaHei\",sans-serif;color:#222;margin:24px;overflow-wrap:anywhere}p{margin:0 0 12px}a{color:#2161a0}</style><body>' +
        html +
        "</body></html>"
      }
    />
  );
}
export function ImageViewer({ ids }: { ids: string[] }) {
  const [index, setIndex] = useState(0),
    [zoom, setZoom] = useState<number | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const source = useRef<HTMLImageElement>(null);
  function fitWidth() {
    const box = viewport.current,
      img = source.current;
    if (!box || !img?.naturalWidth || !box.clientWidth) return 100;
    return Math.min(
      100,
      (((box.clientHeight - 30) * img.naturalWidth) /
        img.naturalHeight /
        (box.clientWidth - 30)) *
        100,
    );
  }
  useEffect(() => {
    setIndex(0);
    setZoom(null);
  }, [ids.join(",")]);
  useEffect(() => {
    if (viewport.current) {
      viewport.current.scrollTop = 0;
      viewport.current.scrollLeft = 0;
    }
  }, [index, ids.join(","), zoom === null]);
  if (!ids.length)
    return (
      <Empty title="没有来源截图" description="可以从截图录入页面补充资料。" />
    );
  return (
    <div className="image-viewer">
      <div className="image-controls">
        <span>
          来源截图 {index + 1} / {ids.length}
        </span>
        <button
          className="icon-button"
          aria-label="缩小截图"
          onClick={() => setZoom((v) => Math.max(5, (v ?? fitWidth()) / 1.25))}
        >
          <ZoomOut size={17} />
        </button>
        <span>{zoom === null ? "整图" : Math.round(zoom) + "%宽"}</span>
        <button
          className="icon-button"
          aria-label="放大截图"
          onClick={() =>
            setZoom((v) => Math.min(300, (v ?? fitWidth()) * 1.25))
          }
        >
          <ZoomIn size={17} />
        </button>
        <button
          className={zoom === null ? "active" : ""}
          onClick={() => setZoom(null)}
        >
          适应窗口
        </button>
        <button
          className={zoom === 100 ? "active" : ""}
          onClick={() => setZoom(100)}
        >
          适合宽度
        </button>
      </div>
      <div
        className={"image-scroll" + (zoom === null ? " fit-image" : "")}
        ref={viewport}
      >
        <img
          src={"/api/v1/screenshots/" + ids[index]}
          ref={source}
          style={
            zoom === null ? undefined : { width: zoom + "%", maxWidth: "none" }
          }
          alt={"来源聊天截图" + (index + 1)}
        />
      </div>
      <div className="thumbs">
        {ids.map((id, i) => (
          <button
            className={index === i ? "selected" : ""}
            key={id}
            onClick={() => {
              setIndex(i);
              setZoom(null);
            }}
          >
            <img
              src={"/api/v1/screenshots/" + id}
              alt={"第" + (i + 1) + "张截图"}
            />
            <span>{i + 1}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
