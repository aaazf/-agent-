import { Palette } from "lucide-react";

const THEMES = [
  { key: "black", label: "曜石黑", color: "#111820" },
  { key: "white", label: "纯净白", color: "#ffffff" },
  { key: "green", label: "青玉绿", color: "#1f9c8f" },
  { key: "ocean", label: "深海蓝", color: "#2d6bc6" },
  { key: "rose", label: "蔷薇玫", color: "#b74c70" },
  { key: "gold", label: "琥珀金", color: "#c08830" }
];

export default function ThemePalette({ theme, onChange }) {
  return (
    <div className="floating-theme">
      <div className="floating-theme-title">
        <Palette size={14} />
        页面配色
      </div>
      <div className="floating-swatches">
        {THEMES.map((item) => (
          <button
            key={item.key}
            type="button"
            className={theme === item.key ? "theme-swatch active" : "theme-swatch"}
            style={{ "--swatch": item.color }}
            title={item.label}
            onClick={() => onChange(item.key)}
          />
        ))}
      </div>
    </div>
  );
}
