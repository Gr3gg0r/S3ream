import { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const baseProps = (size: number): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
});

export const Upload = ({ size = 16, ...props }: IconProps) => (
  <svg {...baseProps(size)} {...props}>
    <path d="M12 15V4" />
    <path d="m8 8 4-4 4 4" />
    <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </svg>
);

export const Check = ({ size = 16, ...props }: IconProps) => (
  <svg {...baseProps(size)} {...props}>
    <path d="m5 12 4.5 4.5L19 7" />
  </svg>
);

export const FolderOpen = ({ size = 16, ...props }: IconProps) => (
  <svg {...baseProps(size)} {...props}>
    <path d="M4 7a2 2 0 0 1 2-2h3l2 2.5h7a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
    <path d="M2.5 12.5 4.2 18a2 2 0 0 0 1.9 1.4h11.8a2 2 0 0 0 1.9-1.4l1.7-5.5a1 1 0 0 0-1-1.25H3.5a1 1 0 0 0-1 1.25Z" />
  </svg>
);

export const Cloud = ({ size = 16, ...props }: IconProps) => (
  <svg {...baseProps(size)} {...props}>
    <path d="M7 18a4 4 0 0 1-.4-8A5.5 5.5 0 0 1 17 9.2a3.5 3.5 0 0 1 .4 6.97A3.5 3.5 0 0 1 17 18Z" />
  </svg>
);

export const Sparkles = ({ size = 16, ...props }: IconProps) => (
  <svg {...baseProps(size)} {...props}>
    <path d="M12 3v4" />
    <path d="M12 17v4" />
    <path d="M3 12h4" />
    <path d="M17 12h4" />
    <path d="m6.3 6.3 2.8 2.8" />
    <path d="m14.9 14.9 2.8 2.8" />
    <path d="m17.7 6.3-2.8 2.8" />
    <path d="m9.1 14.9-2.8 2.8" />
  </svg>
);

export const SlidersHorizontal = ({ size = 16, ...props }: IconProps) => (
  <svg {...baseProps(size)} {...props}>
    <path d="M4 8h10" />
    <path d="M18 8h2" />
    <circle cx="16" cy="8" r="2" />
    <path d="M4 16h2" />
    <path d="M10 16h10" />
    <circle cx="8" cy="16" r="2" />
  </svg>
);

export const Clock = ({ size = 16, ...props }: IconProps) => (
  <svg {...baseProps(size)} {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export const Monitor = ({ size = 16, ...props }: IconProps) => (
  <svg {...baseProps(size)} {...props}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8" />
    <path d="M12 16v4" />
  </svg>
);

export const Sun = ({ size = 16, ...props }: IconProps) => (
  <svg {...baseProps(size)} {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2.5" />
    <path d="M12 19.5V22" />
    <path d="M2 12h2.5" />
    <path d="M19.5 12H22" />
    <path d="m4.9 4.9 1.8 1.8" />
    <path d="m17.3 17.3 1.8 1.8" />
    <path d="m19.1 4.9-1.8 1.8" />
    <path d="m6.7 17.3-1.8 1.8" />
  </svg>
);

export const Moon = ({ size = 16, ...props }: IconProps) => (
  <svg {...baseProps(size)} {...props}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
  </svg>
);

export const ChevronLeft = ({ size = 16, ...props }: IconProps) => (
  <svg {...baseProps(size)} {...props}>
    <path d="m15 5-7 7 7 7" />
  </svg>
);
