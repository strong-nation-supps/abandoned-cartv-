require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();

// raw body needed for Razorpay signature verify
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

const PORT = process.env.PORT || 10000;
const VENDOR_ID = process.env.VENDOR_ID;
const TOKEN = process.env.TOKEN;
const WA_TEMPLATE_NAME = process.env.WA_TEMPLATE_NAME || "cart_2";
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

// stores
const pendingOrders = new Map();
const sentMessages = new Map();

function normalizePhone(phone) {
  if (!phone) return null;

  let p = String(phone).replace(/\D/g, "");

  if (p.startsWith("0")) p = p.slice(1);
  if (p.length === 10) p = "91" + p;

  return p;
}

function isDuplicate(phone) {
  const last = sentMessages.get(phone);
  if (!last) return false;

  const diff = Date.now() - last;
  return diff < 24 * 60 * 60 * 1000;
}

function markSent(phone) {
  sentMessages.set(phone, Date.now());
}

function verifySignature(req) {
  const signature = req.headers["x-razorpay-signature"];
  if (!signature) return false;

  const expected = crypto
    .createHmac("sha256", RAZORPAY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("hex");

  return expected === signature;
}

async function sendWhatsApp(phone, amount) {
  if (!phone) {
    console.log("No phone found");
    return;
  }

  const formattedAmount = amount
    ? `₹${amount / 100}`
    : "your cart amount";

  if (isDuplicate(phone)) {
    console.log("Duplicate blocked:", phone);
    return;
  }

  const url = `https://api.wamantra.com/api/${VENDOR_ID}/contact/send-message?token=${TOKEN}`;

  // TEMPLATE PAYLOAD
  const payload = {
    phone_number: phone,
    template_name: WA_TEMPLATE_NAME,
    template_language: "en",
    field_1: formattedAmount,
    message_body: " "
  };

  try {
    console.log("Sending WA payload:", payload);

    const response = await axios.post(url, payload, {
      headers: {
        "Content-Type": "application/json",
      },
    });

    console.log("WA Template sent successfully:", response.data);
    markSent(phone);
  } catch (err) {
    console.error(
      "WA Error:",
      err.response?.data || err.message
    );
  }
}

// 30 min wait logic
function scheduleAbandoned(orderId, phone, amount) {
  if (!phone) return;

  pendingOrders.set(orderId, {
    phone,
    amount,
    createdAt: Date.now(),
    paid: false,
  });

  setTimeout(async () => {
    const order = pendingOrders.get(orderId);

    if (!order) return;

    if (order.paid) {
      pendingOrders.delete(orderId);
      return;
    }

    console.log("Abandoned checkout detected:", orderId);

    await sendWhatsApp(order.phone, order.amount);

    pendingOrders.delete(orderId);
  }, 30 * 60 * 1000);
}

app.get("/", (req, res) => {
  res.send("Strong Nation Razorpay + WA Mantra Live ✅");
});

app.post("/razorpay-webhook", async (req, res) => {
  try {
    if (!verifySignature(req)) {
      return res.status(401).send("Invalid signature");
    }

    const event = req.body.event;

    const entity =
      req.body.payload?.payment?.entity ||
      req.body.payload?.order?.entity ||
      {};

    const orderId =
      entity.order_id ||
      entity.id ||
      crypto.randomUUID();

    const phone = normalizePhone(
      entity.contact ||
      entity.phone ||
      entity.customer_contact
    );

    const amount = entity.amount || 0;

    console.log("==================================");
    console.log("Event:", event);
    console.log("Phone:", phone);
    console.log("Amount:", amount);
    console.log("==================================");

    // payment failed → instant template msg
    if (event === "payment.failed") {
      await sendWhatsApp(phone, amount);
    }

    // payment authorized → start abandoned timer
    if (event === "payment.authorized") {
      scheduleAbandoned(orderId, phone, amount);
    }

    // payment success → stop automation
    if (
      event === "payment.captured" ||
      event === "order.paid"
    ) {
      const order = pendingOrders.get(orderId);

      if (order) {
        order.paid = true;
        pendingOrders.set(orderId, order);
      }

      console.log("Payment success, automation stopped");
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook Error:", err);
    res.status(500).send("error");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});