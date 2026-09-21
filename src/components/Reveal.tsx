import { useEffect, useRef, type ReactNode } from 'react';
import '../styles/landingAnimations.css';

type RevealProps = {
  children: ReactNode;
  /** Direction the element travels in from. Scroll direction maps to this. */
  from?: 'up' | 'left' | 'right' | 'scale';
  /** Stagger delay in ms. */
  delay?: number;
  className?: string;
};

/**
 * Scroll-reveal that re-triggers on EVERY pass.
 *
 * Unlike a one-shot reveal, the observer keeps watching: it adds `is-revealed`
 * when the element enters (playing the fade/pop) AND removes it when the element
 * leaves the viewport, so scrolling up and down replays the same animation each
 * time — never a dead, once-only fade. `prefers-reduced-motion` collapses it to
 * always-visible with no animation.
 */
export function Reveal({ children, from, delay = 0, className = '' }: RevealProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const reduced = useRef(
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const entered = useRef(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }

    node.classList.add('reveal');
    if (from === 'left') {
      node.classList.add('reveal--from-left');
    } else if (from === 'right') {
      node.classList.add('reveal--from-right');
    } else if (from === 'scale') {
      node.classList.add('reveal--scale');
    }

    if (reduced.current || typeof IntersectionObserver === 'undefined') {
      node.classList.add('is-revealed');
      return;
    }

    const dirSuffix = from === 'left' ? '--left' : from === 'right' ? '--right' : from === 'scale' ? '--scale' : '--up';
    const setState = (revealed: boolean) => {
      entered.current = revealed;
      if (revealed) {
        node.classList.add('is-revealed', `is-revealed${dirSuffix}`);
      } else {
        node.classList.remove('is-revealed', `is-revealed${dirSuffix}`);
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const isNowIn = entry.isIntersecting;
          if (isNowIn && !entered.current) {
            setState(true);
          } else if (!isNowIn && entered.current) {
            setState(false);
          }
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -32px 0px' },
    );

    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [from]);

  return (
    <div
      ref={ref}
      className={className}
      style={delay > 0 ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}
