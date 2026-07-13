import { resolutionOptions } from "@renderer/constants";

interface RenditionPickerProps {
  selectedRenditions: string[];
  onToggle: (id: string) => void;
  disabled?: boolean;
}

export const RenditionPicker = ({
  selectedRenditions,
  onToggle,
  disabled,
}: RenditionPickerProps) => (
  <div className="flex flex-wrap gap-2">
    {resolutionOptions.map((option) => {
      const isSelected = selectedRenditions.includes(option.id);
      return (
        <button
          key={option.id}
          type="button"
          className={`inline-flex h-7 items-center rounded-full border px-3 text-[12px] font-medium transition ${
            isSelected
              ? "border-primary bg-primary text-primary-content"
              : "border-base-300 text-base-content/65 hover:bg-base-200"
          }`}
          onClick={() => onToggle(option.id)}
          disabled={disabled}
        >
          {option.label}
        </button>
      );
    })}
  </div>
);
