import { z } from "zod";

const name = z
  .string({ message: "invalid name" })
  .min(4, { message: "name should be minimum of 03 charachter(s)" })
  .max(26, { message: "name should be mximum of 24 charachter(s)" });

const email = z.email({ message: "invalid email" });

const password = z
  .string({ message: "invalid input" })
  .min(6, { message: "password should be of minimum 06 charachter(s)" })
  .max(24, { message: "password shouldn't be more than 24 charachter(s)" })
  .regex(
    /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{6,}$/,
    {
      message:
        "password(s) require atleast 01 capital-letter, 01 special-charachter, 01 number",
    },
  );

export const authSchema = {
  signup: z.object({
    name,
    email,
    password,
  }),
  login: z.object({
    email,
    password,
  }),
};
