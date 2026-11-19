import { motion } from 'framer-motion'

export default function SectionReveal({ children, className = '', id }) {
  return (
    <motion.section
      id={id}
      className={`scroll-mt-24 ${className}`}
      initial={{ opacity: 0, y: 40, filter: 'blur(6px)' }}
      whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      viewport={{ once: true, margin: '-100px' }}
      transition={{ duration: 0.75, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.section>
  )
}
