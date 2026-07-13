import { ThemePreference } from "@renderer/hooks/useTheme";
import { Monitor, Moon, Sun } from "@renderer/components/icons";

interface ThemeToggleProps {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

const options: Array<{ value: ThemePreference; label: string; Icon: typeof Monitor }> = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

export const ThemeToggle = ({ preference, setPreference }: ThemeToggleProps) => (
  <div className="linear-segmented" role="radiogroup" aria-label="Theme">
    {options.map(({ value, label, Icon }) => (
      <button
        key={value}
        type="button"
        role="radio"
        aria-checked={preference === value}
        data-active={preference === value}
        className="inline-flex items-center gap-1.5"
        onClick={() => setPreference(value)}
      >
        <Icon size={14} />
        {label}
      </button>
    ))}
  </div>
);
