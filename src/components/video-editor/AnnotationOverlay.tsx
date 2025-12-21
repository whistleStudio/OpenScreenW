import { useRef, useState, useEffect, useCallback, memo } from "react";
import { Rnd } from "react-rnd";
import type { AnnotationRegion } from "./types";
import { cn } from "@/lib/utils";
import { getArrowComponent } from "./ArrowSvgs";

interface AnnotationOverlayProps {
  annotation: AnnotationRegion;
  isSelected: boolean;
  containerWidth: number;
  containerHeight: number;
  onPositionChange: (id: string, position: { x: number; y:  number }) => void;
  onSizeChange: (id: string, size: { width: number; height: number }) => void;
  onClick: (id: string) => void;
  zIndex:  number;
  isSelectedBoost:  boolean;
}

const AnnotationOverlayComponent = ({
  annotation,
  isSelected,
  containerWidth,
  containerHeight,
  onPositionChange,
  onSizeChange,
  onClick,
  zIndex,
  isSelectedBoost,
}: AnnotationOverlayProps) => {
  const isDraggingRef = useRef(false);
  const isResizingRef = useRef(false);
  
  // 使用本地状态管理位置和尺寸，避免频繁触发父组件更新
  const [localPosition, setLocalPosition] = useState(() => ({
    x: (annotation.position.x / 100) * containerWidth,
    y: (annotation.position. y / 100) * containerHeight,
  }));
  
  const [localSize, setLocalSize] = useState(() => ({
    width: (annotation.size. width / 100) * containerWidth,
    height: (annotation. size.height / 100) * containerHeight,
  }));

  // 同步外部 props 到本地状态（仅在非交互时）
  useEffect(() => {
    if (! isDraggingRef.current && !isResizingRef.current) {
      setLocalPosition({
        x: (annotation.position.x / 100) * containerWidth,
        y: (annotation.position.y / 100) * containerHeight,
      });
      setLocalSize({
        width: (annotation.size.width / 100) * containerWidth,
        height: (annotation.size.height / 100) * containerHeight,
      });
    }
  }, [
    annotation.position.x,
    annotation.position.y,
    annotation.size.width,
    annotation.size.height,
    containerWidth,
    containerHeight,
  ]);

  const renderArrow = useCallback(() => {
    const direction = annotation.figureData?. arrowDirection || 'right';
    const color = annotation.figureData?.color || '#34B27B';
    const strokeWidth = annotation.figureData?.strokeWidth || 4;

    const ArrowComponent = getArrowComponent(direction);
    return <ArrowComponent color={color} strokeWidth={strokeWidth} />;
  }, [annotation.figureData]);

  const renderContent = useCallback(() => {
    switch (annotation.type) {
      case 'text':
        return (
          <div
            className="w-full h-full flex items-center p-2 overflow-hidden"
            style={{
              justifyContent: annotation.style.textAlign === 'left' ? 'flex-start' : 
                            annotation.style.textAlign === 'right' ? 'flex-end' : 'center',
              alignItems: 'center',
            }}
          >
            <span
              style={{
                color: annotation.style.color,
                backgroundColor: annotation.style.backgroundColor,
                fontSize: `${annotation.style.fontSize}px`,
                fontFamily: annotation.style.fontFamily,
                fontWeight: annotation.style.fontWeight,
                fontStyle: annotation.style.fontStyle,
                textDecoration: annotation.style.textDecoration,
                textAlign: annotation.style.textAlign,
                wordBreak: 'break-word',
                whiteSpace: 'pre-wrap',
                boxDecorationBreak: 'clone',
                WebkitBoxDecorationBreak: 'clone',
                padding: '0.1em 0.2em',
                borderRadius: '4px',
                lineHeight: '1.4',
              }}
            >
              {annotation.content}
            </span>
          </div>
        );

      case 'image':
        if (annotation.content && annotation.content.startsWith('data:image')) {
          return (
            <img
              src={annotation.content}
              alt="Annotation"
              className="w-full h-full object-contain"
              draggable={false}
            />
          );
        }
        return (
          <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">
            No image
          </div>
        );

      case 'figure':
        if (! annotation.figureData) {
          return (
            <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">
              No arrow data
            </div>
          );
        }

        return (
          <div className="w-full h-full flex items-center justify-center p-2">
            {renderArrow()}
          </div>
        );

      default:
        return null;
    }
  }, [annotation.type, annotation.content, annotation.style, annotation.figureData, renderArrow]);

  const handleDragStart = useCallback(() => {
    isDraggingRef.current = true;
  }, []);

  const handleDrag = useCallback((_e: unknown, d: { x: number; y: number }) => {
    // 拖拽过程中只更新本地状态，不触发父组件
    setLocalPosition({ x: d.x, y: d.y });
  }, []);

  const handleDragStop = useCallback(
    (_e: unknown, d: { x: number; y:  number }) => {
      const xPercent = (d.x / containerWidth) * 100;
      const yPercent = (d. y / containerHeight) * 100;
      onPositionChange(annotation.id, { x: xPercent, y: yPercent });
      
      // 延迟重置标志以防止误触发 click
      requestAnimationFrame(() => {
        isDraggingRef.current = false;
      });
    },
    [containerWidth, containerHeight, onPositionChange, annotation.id]
  );

  const handleResizeStart = useCallback(() => {
    isResizingRef. current = true;
  }, []);

  const handleResize = useCallback(
    (
      _e: unknown,
      _direction: unknown,
      ref: HTMLElement,
      _delta: unknown,
      position: { x: number; y:  number }
    ) => {
      // 缩放过程中只更新本地状态
      setLocalPosition({ x: position.x, y: position.y });
      setLocalSize({ width: ref.offsetWidth, height: ref.offsetHeight });
    },
    []
  );

  const handleResizeStop = useCallback(
    (
      _e: unknown,
      _direction: unknown,
      ref: HTMLElement,
      _delta: unknown,
      position: { x: number; y:  number }
    ) => {
      const xPercent = (position.x / containerWidth) * 100;
      const yPercent = (position.y / containerHeight) * 100;
      const widthPercent = (ref.offsetWidth / containerWidth) * 100;
      const heightPercent = (ref.offsetHeight / containerHeight) * 100;
      
      onPositionChange(annotation.id, { x: xPercent, y:  yPercent });
      onSizeChange(annotation.id, { width: widthPercent, height: heightPercent });
      
      requestAnimationFrame(() => {
        isResizingRef.current = false;
      });
    },
    [containerWidth, containerHeight, onPositionChange, onSizeChange, annotation.id]
  );

  const handleClick = useCallback(() => {
    if (isDraggingRef.current || isResizingRef.current) return;
    onClick(annotation.id);
  }, [onClick, annotation.id]);

  return (
    <Rnd
      position={localPosition}
      size={localSize}
      onDragStart={handleDragStart}
      onDrag={handleDrag}
      onDragStop={handleDragStop}
      onResizeStart={handleResizeStart}
      onResize={handleResize}
      onResizeStop={handleResizeStop}
      onClick={handleClick}
      bounds="parent"
      className={cn(
        "cursor-move", // ← 移除 transition-all
        isSelected && "ring-2 ring-[#34B27B] ring-offset-2 ring-offset-transparent"
      )}
      style={{
        zIndex: isSelectedBoost ? zIndex + 1000 : zIndex,
        pointerEvents: isSelected ? 'auto' : 'none',
        border: isSelected ? '2px solid rgba(52, 178, 123, 0.8)' : 'none',
        backgroundColor: isSelected ? 'rgba(52, 178, 123, 0.1)' : 'transparent',
        boxShadow: isSelected ? '0 0 0 1px rgba(52, 178, 123, 0.35)' : 'none',
        // GPU 加速 + 提示浏览器优化
        transform: 'translate3d(0, 0, 0)',
        willChange: isDraggingRef.current || isResizingRef.current ?  'transform' : 'auto',
      }}
      enableResizing={isSelected}
      disableDragging={! isSelected}
      resizeHandleStyles={{
        topLeft:  {
          width: '12px',
          height: '12px',
          backgroundColor: isSelected ?  'white' : 'transparent',
          border: isSelected ?  '2px solid #34B27B' : 'none',
          borderRadius: '50%',
          left: '-6px',
          top: '-6px',
          cursor: 'nwse-resize',
        },
        topRight: {
          width: '12px',
          height: '12px',
          backgroundColor: isSelected ? 'white' : 'transparent',
          border: isSelected ? '2px solid #34B27B' : 'none',
          borderRadius:  '50%',
          right:  '-6px',
          top:  '-6px',
          cursor:  'nesw-resize',
        },
        bottomLeft: {
          width: '12px',
          height: '12px',
          backgroundColor: isSelected ? 'white' : 'transparent',
          border: isSelected ? '2px solid #34B27B' : 'none',
          borderRadius: '50%',
          left: '-6px',
          bottom: '-6px',
          cursor: 'nesw-resize',
        },
        bottomRight: {
          width: '12px',
          height: '12px',
          backgroundColor: isSelected ? 'white' : 'transparent',
          border: isSelected ? '2px solid #34B27B' : 'none',
          borderRadius:  '50%',
          right:  '-6px',
          bottom:  '-6px',
          cursor:  'nwse-resize',
        },
      }}
    >
      <div
        className={cn(
          "w-full h-full rounded-lg",
          annotation.type === 'text' && "bg-transparent",
          annotation.type === 'image' && "bg-transparent",
          annotation.type === 'figure' && "bg-transparent",
          isSelected && "shadow-lg"
        )}
      >
        {renderContent()}
      </div>
    </Rnd>
  );
};

// 优化 memo 比较逻辑
export const AnnotationOverlay = memo(AnnotationOverlayComponent, (prev, next) => {
  // 如果正在交互，不要因为外部 props 变化而重新渲染
  // （本地状态会处理实时更新）
  
  // 基础属性比较
  if (
    prev.annotation.id !== next.annotation.id ||
    prev.isSelected !== next.isSelected ||
    prev.containerWidth !== next. containerWidth ||
    prev.containerHeight !== next.containerHeight ||
    prev.zIndex !== next. zIndex ||
    prev.isSelectedBoost !== next.isSelectedBoost
  ) {
    return false; // 需要重新渲染
  }

  // 内容相关属性比较
  if (
    prev.annotation.type !== next.annotation.type ||
    prev.annotation.content !== next. annotation.content
  ) {
    return false;
  }

  // 样式比较（仅在选中时重要）
  if (next.isSelected) {
    const prevStyle = prev.annotation.style;
    const nextStyle = next.annotation.style;
    
    if (
      prevStyle. color !== nextStyle.color ||
      prevStyle.backgroundColor !== nextStyle. backgroundColor ||
      prevStyle.fontSize !== nextStyle.fontSize ||
      prevStyle.fontFamily !== nextStyle.fontFamily ||
      prevStyle.fontWeight !== nextStyle.fontWeight ||
      prevStyle.fontStyle !== nextStyle.fontStyle ||
      prevStyle.textDecoration !== nextStyle.textDecoration ||
      prevStyle.textAlign !== nextStyle.textAlign
    ) {
      return false;
    }
  }

  // 图形数据比较
  if (prev.annotation.type === 'figure' && next. annotation.type === 'figure') {
    const prevFigure = prev.annotation.figureData;
    const nextFigure = next.annotation.figureData;
    
    if (
      prevFigure?. arrowDirection !== nextFigure?.arrowDirection ||
      prevFigure?.color !== nextFigure?.color ||
      prevFigure?.strokeWidth !== nextFigure?.strokeWidth
    ) {
      return false;
    }
  }

  // 位置和尺寸比较（仅在未选中时）
  // 选中时位置由本地状态管理，不需要因为外部 props 变化而重新渲染
  if (!next.isSelected) {
    if (
      prev.annotation.position.x !== next.annotation.position.x ||
      prev.annotation.position.y !== next.annotation.position.y ||
      prev.annotation.size.width !== next.annotation.size.width ||
      prev.annotation.size.height !== next.annotation.size.height
    ) {
      return false;
    }
  }

  return true; // 不需要重新渲染
});

AnnotationOverlay.displayName = 'AnnotationOverlay';