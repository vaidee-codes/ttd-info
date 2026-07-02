export type TempleInfo = {
  slug: string;
  name: string;
  location: string;
  officialFee: string;
  bookingType: "free" | "paid";
  riskLevel: "low" | "medium" | "high";
  riskNote: string;
  blurb: string;
};

export const TEMPLES: TempleInfo[] = [
  {
    slug: "ttd-special-entry",
    name: "TTD Special Entry / VIP Darshan (Tirumala)",
    location: "Tirumala, Andhra Pradesh",
    officialFee: "₹300 (Sheegra Darshan) – ₹500 (VIP Break Darshan)",
    bookingType: "paid",
    riskLevel: "medium",
    riskNote:
      "We coach you through the official TTD portal in real time. You log in and submit with your own credentials — we never take over your account.",
    blurb:
      "The most requested darshan slot at Tirumala. We help you prepare documents, time the booking window, and complete the form yourself.",
  },
  {
    slug: "ttd-srivani",
    name: "TTD Srivani Trust Darshan (Tirumala)",
    location: "Tirumala, Andhra Pradesh",
    officialFee: "₹10,000 donation + ₹500 darshan ticket, per person",
    bookingType: "paid",
    riskLevel: "high",
    riskNote:
      "Available only as a free add-on inside a full logistics package — never sold as a standalone booking service, in line with TTD's crackdown on paid facilitation of Srivani slots.",
    blurb:
      "A high-demand donor darshan scheme. We only assist Srivani bookings for customers who've already booked a full travel package with us.",
  },
  {
    slug: "sabarimala",
    name: "Sabarimala Virtual Queue (Ayyappa Temple)",
    location: "Sabarimala, Kerala",
    officialFee: "Free (Virtual Q coupon)",
    bookingType: "free",
    riskLevel: "high",
    riskNote:
      "The Travancore Devaswom Board has stated no agent is authorized to charge for Virtual Q coupons. We never charge for this step — booking coaching is a free inclusion in trip packages only.",
    blurb:
      "We help with trip logistics — transport, stay, mandatory medical-fitness guidance, and trek support — around your free Virtual Q booking.",
  },
  {
    slug: "vaishno-devi",
    name: "Vaishno Devi Yatra Parchi",
    location: "Katra, Jammu & Kashmir",
    officialFee: "Free (Yatra Parchi registration)",
    bookingType: "free",
    riskLevel: "low",
    riskNote:
      "Registration itself is free and we never charge for it. Paid help is limited to genuinely separate services like helicopter ticket assistance and local logistics.",
    blurb:
      "Free registration coaching, plus optional paid help with helicopter tickets, pony/palki arrangements, and accommodation in Katra.",
  },
  {
    slug: "shirdi",
    name: "Shirdi Sai Baba VIP / Special Darshan",
    location: "Shirdi, Maharashtra",
    officialFee: "₹300 (Special) – ₹500 (VIP)",
    bookingType: "paid",
    riskLevel: "low",
    riskNote:
      "Official-price pass-through plus bundled local logistics, the same model used by established Shirdi travel operators.",
    blurb:
      "VIP pass booking coaching bundled with local transport and stay arrangements.",
  },
  {
    slug: "kashi-vishwanath",
    name: "Kashi Vishwanath Sugam Darshan",
    location: "Varanasi, Uttar Pradesh",
    officialFee: "~₹300 (Sugam Darshan)",
    bookingType: "paid",
    riskLevel: "low",
    riskNote:
      "Official-price pass-through plus bundled local logistics.",
    blurb:
      "Priority Sugam Darshan booking coaching bundled with Ganga Aarti scheduling and local logistics help.",
  },
];

export type ServiceTier = {
  id: string;
  name: string;
  price: string;
  description: string;
  features: string[];
};

export const SERVICE_TIERS: ServiceTier[] = [
  {
    id: "coaching",
    name: "Booking Coaching",
    price: "₹300 – ₹800 per booking",
    description:
      "You keep control — we get you ready and stay on the call while you book.",
    features: [
      "Document checklist review before the booking window",
      "Live phone/video support during the official booking window",
      "Quota-release reminders for your chosen temple",
      "You log in and submit with your own credentials, always",
    ],
  },
  {
    id: "logistics",
    name: "End-to-End Logistics",
    price: "₹1,500 – ₹5,000+ per group",
    description:
      "Everything in Booking Coaching, plus full trip planning and on-ground support.",
    features: [
      "Transport and accommodation arrangements",
      "On-ground coordinator for your visit",
      "Priority scheduling across multiple sevas/darshans",
      "Includes free Srivani/Sabarimala booking coaching where applicable",
    ],
  },
];
