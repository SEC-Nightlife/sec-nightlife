import Nav from './components/Nav'
import Hero from './components/Hero'
import Purpose from './components/Purpose'
import Offers from './components/Offers'
import Venues from './components/Venues'
import PartyGoers from './components/PartyGoers'
import HowItWorks from './components/HowItWorks'
import Platform from './components/Platform'
import Watch from './components/Watch'
import Footer from './components/Footer'

export default function App() {
  return (
    <div className="min-h-screen bg-black text-sec-text">
      <Nav />
      <main>
        <Hero />
        <Purpose />
        <Offers />
        <Venues />
        <PartyGoers />
        <HowItWorks />
        <Platform />
        <Watch />
      </main>
      <Footer />
    </div>
  )
}
