import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { ArrowIcon, CameraIcon, CheckIcon, PesoIcon, PhoneIcon, RouteIcon, ShieldIcon, TruckIcon, UsersIcon, WifiOffIcon } from "@/components/icons";

export const metadata: Metadata = {
  title: "Truckwise: run your trucking business from one place",
  description:
    "Dispatch trips, collect proof of delivery, bill clients and pay subcontractors and drivers. Truckwise is trucking management software built for Philippine haulers.",
};

const features = [
  { Icon: RouteIcon, title: "Dispatch without the group chat", text: "Create a trip, assign a truck and driver or a subcontractor, and watch its status move from booked to delivered on one board and calendar." },
  { Icon: CameraIcon, title: "Proof of delivery, on the phone", text: "Drivers take photos and capture signatures at every stop. Staff approve or reject them, and approved proof is locked so it cannot be edited later." },
  { Icon: PesoIcon, title: "Invoices and costs in pesos", text: "Quote a trip, send invoices, and record income and expenses by truck: diesel, tolls, RFID, maintenance and salaries. See profit per trip and per truck." },
  { Icon: UsersIcon, title: "Subcontractors see their own earnings", text: "Invite partner truck owners with their own login. They see only their trips, rates and settlements, never your other business." },
  { Icon: ShieldIcon, title: "Documents your clients ask for", text: "Set the papers each client needs per trip. A trip is not ready to invoice until every required document is approved or waived." },
  { Icon: WifiOffIcon, title: "Works where the signal does not", text: "Drivers keep working on the road. Proof is saved on the phone and sent as soon as the connection returns." },
];

const steps = [
  { title: "Book the trip", text: "Enter the client, route, stops and price. Choose your own truck or a subcontractor." },
  { title: "Driver delivers", text: "The driver gets the job on their phone and uploads photos and signatures at each stop." },
  { title: "You approve", text: "Review proof and required documents. Anything missing is flagged before you bill." },
  { title: "Bill and settle", text: "Invoice the client, then settle drivers and subcontractors from the same record." },
];

const roles = ["Company owner", "Operations manager", "Dispatcher", "Accountant", "Driver", "Subcontractor owner", "Subcontractor driver"];

export default function Home() {
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="nav">
        <div className="wrap nav-in">
          <Logo href="/" />
          <nav className="nav-links" aria-label="Sections">
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#partners">Subcontractors</a>
            <a href="#security">Security</a>
          </nav>
          <div className="nav-cta">
            <Link href="/login" className="btn btn-primary">Sign in</Link>
          </div>
        </div>
      </header>

      <main id="main">
        <section className="hero">
          <div className="wrap hero-grid">
            <div>
              <span className="pill"><i /> Built for Philippine haulers</span>
              <h1>
                Run every trip, <em>from booking to payment</em>
              </h1>
              <p className="lead">
                Truckwise puts dispatch, proof of delivery, invoicing, costs and subcontractor pay in one place, so
                nothing gets lost between the office, the driver and the client.
              </p>
              <div className="hero-cta">
                <Link href="/login" className="btn btn-primary">
                  Sign in <ArrowIcon size={18} />
                </Link>
                <a href="#how" className="btn btn-ghost">See how it works</a>
              </div>
              <p className="hero-note">Works on any phone or computer. No app to install.</p>
            </div>

            <div className="board" role="img" aria-label="Example of the Truckwise trip board">
              <div className="board-top">
                <span className="dot" /><span className="dot" /><span className="dot" />
                <span style={{ marginLeft: 8 }}>Trips today</span>
              </div>
              <div className="board-body">
                <div className="trip">
                  <div className="trip-h"><span className="trip-id mono">TW-0142</span><span className="tag tag-info">On the road</span></div>
                  <div className="route"><span>From</span><b>Batangas Port</b><span>To</span><b>Calamba warehouse</b></div>
                  <div className="bar"><i style={{ width: "62%" }} /></div>
                </div>
                <div className="trip">
                  <div className="trip-h"><span className="trip-id mono">TW-0141</span><span className="tag tag-warn">Proof to review</span></div>
                  <div className="route"><span>From</span><b>Manila North Harbor</b><span>To</span><b>Valenzuela depot</b></div>
                  <div className="bar"><i style={{ width: "100%" }} /></div>
                </div>
                <div className="trip">
                  <div className="trip-h"><span className="trip-id mono">TW-0140</span><span className="tag tag-ok">Ready to invoice</span></div>
                  <div className="route"><span>From</span><b>Subic</b><span>To</span><b>Clark</b></div>
                  <div className="bar"><i style={{ width: "100%" }} /></div>
                </div>
              </div>
              <p className="caption">Sample data for illustration.</p>
            </div>
          </div>
        </section>

        <section id="features" className="sec alt">
          <div className="wrap">
            <div className="sec-head">
              <span className="eyebrow">What you get</span>
              <h2>Everything a trucking office does, without the spreadsheets</h2>
              <p>One system for the owner, the dispatcher, the accountant, the driver and your partner truck owners.</p>
            </div>
            <div className="grid-3">
              {features.map(({ Icon, title, text }) => (
                <article className="card" key={title}>
                  <div className="icon"><Icon size={22} /></div>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="how" className="sec">
          <div className="wrap">
            <div className="sec-head">
              <span className="eyebrow">How it works</span>
              <h2>From booking to getting paid in four steps</h2>
            </div>
            <div className="steps">
              {steps.map((s) => (
                <div className="step" key={s.title}>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="partners" className="sec alt">
          <div className="wrap split">
            <div>
              <span className="eyebrow">For subcontractors</span>
              <h2 style={{ fontSize: "clamp(28px, 3.6vw, 40px)", letterSpacing: "-.025em", lineHeight: 1.1, margin: "10px 0 14px" }}>
                Own a truck? Join as a partner
              </h2>
              <p style={{ color: "var(--ink-2)", fontSize: 18 }}>
                Haulers share an application link. You fill in your details, add every truck with its photos, and the
                company reviews it. Once approved you get your own login.
              </p>
              <ul className="checks">
                <li><CheckIcon size={18} /><span><b>Add more than one truck</b> with plate, type, size and photos.</span></li>
                <li><CheckIcon size={18} /><span><b>See your trips and rates</b> as soon as they are assigned to you.</span></li>
                <li><CheckIcon size={18} /><span><b>Track your earnings</b> and settlements without calling the office.</span></li>
              </ul>
            </div>
            <div className="card">
              <div className="icon"><TruckIcon size={22} /></div>
              <h3>Who uses Truckwise</h3>
              <p style={{ marginBottom: 16 }}>Each person sees only what their job needs.</p>
              <div className="roles">
                {roles.map((r) => <span className="role" key={r}>{r}</span>)}
              </div>
            </div>
          </div>
        </section>

        <section id="security" className="sec">
          <div className="wrap split">
            <div>
              <span className="eyebrow">Security</span>
              <h2 style={{ fontSize: "clamp(28px, 3.6vw, 40px)", letterSpacing: "-.025em", lineHeight: 1.1, margin: "10px 0 14px" }}>
                Your data stays yours
              </h2>
              <p style={{ color: "var(--ink-2)", fontSize: 18 }}>
                Every company is walled off at the database level. A subcontractor can never see another company&apos;s trips, and neither can you see theirs.
              </p>
            </div>
            <ul className="checks" style={{ marginTop: 0 }}>
              <li><ShieldIcon size={18} /><span><b>Separate data per company</b>, enforced by the database itself.</span></li>
              <li><ShieldIcon size={18} /><span><b>Role-based access</b>: drivers, accountants and partners each get only what they need.</span></li>
              <li><ShieldIcon size={18} /><span><b>Locked proof of delivery</b> once approved, with a full history of who changed what.</span></li>
              <li><PhoneIcon size={18} /><span><b>Notifications</b> when proof arrives, a trip changes or a subscription is about to end.</span></li>
            </ul>
          </div>
        </section>

        <div className="wrap">
          <section className="cta" aria-labelledby="cta-h">
            <h2 id="cta-h">Ready to see your whole operation in one place?</h2>
            <p>Sign in to your company, or ask your hauler for a login or subcontractor application link.</p>
            <Link href="/login" className="btn btn-primary">
              Sign in <ArrowIcon size={18} />
            </Link>
          </section>
        </div>
      </main>

      <footer className="foot">
        <div className="wrap foot-in">
          <div>
            <Logo href="/" />
            <p style={{ marginTop: 10 }}>Trucking management for Philippine haulers.</p>
          </div>
          <nav className="foot-links" aria-label="Footer">
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#partners">Subcontractors</a>
            <Link href="/login">Sign in</Link>
          </nav>
        </div>
      </footer>
    </>
  );
}
